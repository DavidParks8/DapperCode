import renderer, { act } from 'react-test-renderer';

jest.mock('react-native-reanimated', () => jest.requireActual('../testing/reanimatedMock'));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('../testing/gestureHandlerMock'),
);

import { useDrawerController } from './useDrawerController';
import { mockGestureByTestId, resetMockGestures, simulatePan } from '../testing/gestureHandlerMock';
import { mockSharedValues, resetMockSharedValues } from '../testing/reanimatedMock';
import { createTestStore, withAppStore } from '../state/testing';
import {
  drawerCapturesTouchesAtom,
  drawerOpenAtom,
  drawerVisibleAtom,
} from '../state/drawer/atoms';
import {
  currentScreenAtom,
  pushNavigationRouteAtom,
  screenNavigationCommandsAtom,
  settingsAllowsDrawerGestureAtom,
} from '../state/navigation/atoms';
import type { AppStore } from '../state/types';

const SCREEN_WIDTH = 390;
const DRAWER_WIDTH = 390;

function Harness({ onBackSwipe }: { onBackSwipe: () => void }) {
  useDrawerController({
    usesTabletLayout: false,
    screenWidth: SCREEN_WIDTH,
    drawerWidth: DRAWER_WIDTH,
    onBackSwipe,
  });
  return null;
}

function render(store: AppStore, onBackSwipe: () => void) {
  act(() => {
    renderer.create(withAppStore(store, <Harness onBackSwipe={onBackSwipe} />));
  });
}

/** The drawer translation shared value is the first one `useDrawerController` creates. */
function drawerOffsetValue(): number {
  return mockSharedValues[0]?.value as number;
}

describe('app edge swipe gesture', () => {
  beforeEach(() => {
    resetMockGestures();
    resetMockSharedValues();
  });

  it('drags the session drawer open from the Settings edge instead of popping to the chat screen', () => {
    const store = createTestStore();
    store.set(currentScreenAtom, 'Settings');
    const onBackSwipe = jest.fn();
    render(store, onBackSwipe);

    const gesture = mockGestureByTestId('app-back-swipe');
    expect(gesture.config.enabled).toBe(true);

    act(() => {
      gesture.onStart?.({ translationX: 0 });
      gesture.onUpdate?.({ translationX: 120 });
    });

    // Following the finger is what makes the transition smooth instead of an instant screen swap.
    expect(drawerOffsetValue()).toBe(-DRAWER_WIDTH + 120);
    expect(store.get(drawerVisibleAtom)).toBe(true);
    expect(store.get(currentScreenAtom)).toBe('Settings');

    act(() => {
      gesture.onEnd?.({ translationX: 220, velocityX: 800 });
      gesture.onFinalize?.({ translationX: 220, velocityX: 800 });
    });

    expect(drawerOffsetValue()).toBe(0);
    expect(store.get(drawerOpenAtom)).toBe(true);
    expect(store.get(drawerVisibleAtom)).toBe(true);
    expect(store.get(drawerCapturesTouchesAtom)).toBe(true);
    expect(onBackSwipe).not.toHaveBeenCalled();
    expect(store.get(currentScreenAtom)).toBe('Settings');
  });

  it('does not pop the Settings screen when the edge swipe completes', () => {
    const store = createTestStore();
    store.set(currentScreenAtom, 'Settings');
    const onBackSwipe = jest.fn();
    render(store, onBackSwipe);

    act(() => {
      simulatePan(
        mockGestureByTestId('app-back-swipe'),
        [{ translationX: 0 }, { translationX: 220 }],
        {
          translationX: 220,
          velocityX: 800,
        },
      );
    });

    expect(onBackSwipe).not.toHaveBeenCalled();
    expect(store.get(currentScreenAtom)).toBe('Settings');
  });

  it('settles the Settings drawer closed again when the swipe is abandoned', () => {
    const store = createTestStore();
    store.set(currentScreenAtom, 'Settings');
    const onBackSwipe = jest.fn();
    render(store, onBackSwipe);

    const gesture = mockGestureByTestId('app-back-swipe');
    act(() => {
      simulatePan(gesture, [{ translationX: 0 }, { translationX: 20 }], {
        translationX: 20,
        velocityX: 0,
      });
    });

    expect(drawerOffsetValue()).toBe(-DRAWER_WIDTH);
    expect(store.get(drawerOpenAtom)).toBe(false);
    expect(onBackSwipe).not.toHaveBeenCalled();
    expect(store.get(currentScreenAtom)).toBe('Settings');
  });

  it('keeps the Settings edge swipe disabled while a settings sub-view owns the gesture', () => {
    const store = createTestStore();
    store.set(currentScreenAtom, 'Settings');
    store.set(settingsAllowsDrawerGestureAtom, false);
    render(store, jest.fn());

    expect(mockGestureByTestId('app-back-swipe').config.enabled).toBe(false);
  });

  it('still navigates back from other pushed screens', () => {
    const store = createTestStore();
    store.set(currentScreenAtom, 'Browser');
    const onBackSwipe = jest.fn();
    render(store, onBackSwipe);

    const gesture = mockGestureByTestId('app-back-swipe');
    act(() => {
      simulatePan(gesture, [{ translationX: 0 }, { translationX: 200 }], {
        translationX: 200,
        velocityX: 400,
      });
    });

    expect(onBackSwipe).toHaveBeenCalledTimes(1);
    expect(store.get(drawerOpenAtom)).toBe(false);
    expect(drawerOffsetValue()).toBe(-DRAWER_WIDTH);
  });

  /**
   * `backSwipeOffset` is the 4th shared value created by `useDrawerController`
   * (index 3 in hook order: drawerOffset, drawerDragStartOffset, drawerGestureDidSettle,
   * backSwipeOffset, …).
   */
  function backSwipeOffsetValue(): number {
    return mockSharedValues[3]?.value as number;
  }

  it.each([
    ['WorkspacePicker'],
    ['GitCheckout'],
    ['Browser'],
    ['ChatGit'],
  ] as const)(
    'drives backSwipeOffset while swiping and calls onBackSwipe only after the spring settles (%s)',
    (screen) => {
      const store = createTestStore();
      store.set(currentScreenAtom, screen);
      const onBackSwipe = jest.fn();
      render(store, onBackSwipe);

      const gesture = mockGestureByTestId('app-back-swipe');
      expect(gesture.config.enabled).toBe(true);

      // Mid-drag: offset should track the finger; navigation must not have fired yet.
      act(() => {
        gesture.onStart?.({ translationX: 0 });
        gesture.onUpdate?.({ translationX: 80 });
      });
      expect(backSwipeOffsetValue()).toBe(80);
      expect(onBackSwipe).not.toHaveBeenCalled();

      // Complete the swipe past the threshold.
      act(() => {
        gesture.onEnd?.({ translationX: 220, velocityX: 400 });
        gesture.onFinalize?.({ translationX: 220, velocityX: 400 });
      });

      // withSpring is synchronous in the mock, so the spring callback fires immediately and calls
      // onBackSwipe.  (In the mock, `value = withSpring(target, ...)` assigns the *return value*
      // after the callback has already run, so the shared value ends at screenWidth rather than
      // the 0 reset inside the callback — this is a mock artifact; production resets to 0 via
      // the animation engine.)
      expect(onBackSwipe).toHaveBeenCalledTimes(1);
    },
  );

  it('does not call onBackSwipe when the swipe is too short', () => {
    const store = createTestStore();
    store.set(currentScreenAtom, 'Browser');
    const onBackSwipe = jest.fn();
    render(store, onBackSwipe);

    act(() => {
      simulatePan(mockGestureByTestId('app-back-swipe'), [{ translationX: 20 }], {
        translationX: 20,
        velocityX: 0,
      });
    });

    expect(onBackSwipe).not.toHaveBeenCalled();
    // Offset settles back to 0 after a short swipe.
    expect(backSwipeOffsetValue()).toBe(0);
  });

  it('registers triggerAnimatedPop on screenNavigationCommandsAtom', () => {
    const store = createTestStore();
    store.set(pushNavigationRouteAtom, { screen: 'WorkspacePicker' });
    render(store, jest.fn());

    const commands = store.get(screenNavigationCommandsAtom);
    expect(typeof commands.triggerAnimatedPop).toBe('function');
  });
});
