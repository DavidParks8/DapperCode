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
import { currentScreenAtom, settingsAllowsDrawerGestureAtom } from '../state/navigation/atoms';
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
});
