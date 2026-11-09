import { Provider, createStore } from 'jotai';
import type * as ReactModule from 'react';
import {
  AppState,
  Dimensions,
  Keyboard,
  Text,
  type AppStateStatus,
  type KeyboardEvent,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { windowTraitsAtom } from '@shell/state/layout/atoms';
import { keyboardFocusBlockersAtom, useKeyboardFocusBlocker } from '@shell/state/keyboard';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { AppSheet } from '@shared/ui/AppSheet';
import { useLaptopKeyboard } from './useLaptopKeyboard';

let mockRouteFocused = true;
jest.mock('expo-router', () => {
  const { useEffect: mockUseEffect } = jest.requireActual<typeof ReactModule>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      mockUseEffect(() => (mockRouteFocused ? effect() : undefined), [effect, mockRouteFocused]);
    },
  };
});

const laptopTraits = {
  horizontalSizeClass: 'regular',
  verticalSizeClass: 'regular',
  divisions: [{ x: 0, y: 455.5, width: 669, height: 40 }],
} as const;
const originalAppState = AppState.currentState;

type Queryable = ReactTestInstance & {
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

describe('laptop keyboard focus across covering surfaces and lifecycle transitions', () => {
  // A stand-in for the composer's TextInput: focusing it sticks until something resigns it.
  let composerFocused = false;
  const focus = jest.fn(() => {
    composerFocused = true;
  });
  const inputRef = { current: { focus, isFocused: () => composerFocused } };
  const frames = new Map<number, FrameRequestCallback>();
  const keyboardHandlers = new Set<(event: KeyboardEvent) => void>();
  const stateHandlers = new Set<(state: AppStateStatus) => void>();
  let frameId = 0;
  let store: ReturnType<typeof createStore>;
  let tree: ReactTestRenderer;

  function Chat({ drawerOpen = false }: { drawerOpen?: boolean }) {
    useKeyboardFocusBlocker(drawerOpen);
    useLaptopKeyboard(inputRef);
    return null;
  }

  function content(sheetOpen = false, drawerOpen = false) {
    return (
      <Provider store={store}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 669, height: 951 },
            insets: { top: 30, left: 0, right: 0, bottom: 20 },
          }}
        >
          <AppThemeProvider theme={createAppTheme('dark')}>
            <Chat drawerOpen={drawerOpen} />
            <AppSheet visible={sheetOpen} onClose={() => tree.update(content(false, drawerOpen))}>
              <Text>Rename form</Text>
            </AppSheet>
          </AppThemeProvider>
        </SafeAreaProvider>
      </Provider>
    );
  }

  function flushFocus() {
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    });
  }

  function hideKeyboard() {
    act(() => keyboardHandlers.forEach((handler) => handler({} as KeyboardEvent)));
    flushFocus();
  }

  /** Something resigned the composer, such as an interactive dismissal or `Keyboard.dismiss`. */
  function dismissKeyboard() {
    composerFocused = false;
    hideKeyboard();
  }

  beforeEach(() => {
    store = createStore();
    composerFocused = false;
    focus.mockClear();
    frames.clear();
    keyboardHandlers.clear();
    stateHandlers.clear();
    mockRouteFocused = true;
    Dimensions.set({
      window: { width: 669, height: 951, scale: 3, fontScale: 1 },
      screen: { width: 466, height: 678, scale: 3, fontScale: 1 },
    });
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
      if (typeof id === 'number') {
        frames.delete(id);
      }
    });
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, handler) => {
      if (name === 'keyboardDidHide') {
        keyboardHandlers.add(handler);
      }
      return {
        remove: () => {
          keyboardHandlers.delete(handler);
        },
      } as ReturnType<typeof Keyboard.addListener>;
    });
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
      composerFocused = false;
    });
    AppState.currentState = 'active';
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, handler) => {
      stateHandlers.add(handler);
      return { remove: () => stateHandlers.delete(handler) };
    });
    act(() => {
      tree = renderer.create(content());
    });
  });

  afterEach(() => {
    act(() => tree.unmount());
    expect(store.get(keyboardFocusBlockersAtom).size).toBe(0);
    expect(frames.size).toBe(0);
    expect(keyboardHandlers.size).toBe(0);
    expect(stateHandlers.size).toBe(0);
    jest.restoreAllMocks();
    AppState.currentState = originalAppState;
    Dimensions.set({
      window: { width: 750, height: 1334, scale: 2, fontScale: 1 },
      screen: { width: 750, height: 1334, scale: 2, fontScale: 1 },
    });
  });

  it('opens on entering laptop pose, restores a dismissed keyboard, and stops when unfolded', () => {
    flushFocus();
    expect(focus).not.toHaveBeenCalled();
    act(() => store.set(windowTraitsAtom, laptopTraits));
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    dismissKeyboard();
    expect(focus).toHaveBeenCalledTimes(2);
    act(() => store.set(windowTraitsAtom, null));
    dismissKeyboard();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('leaves a keyboard hidden by a system alert to UIKit instead of fighting it for focus', () => {
    // Measured on the iPhone Duo simulator: re-focusing after the App Store review prompt hid the
    // keyboard made the composer bounce between the keyboard and the bottom edge until dismissed.
    act(() => store.set(windowTraitsAtom, laptopTraits));
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    for (let hides = 0; hides < 3; hides += 1) {
      hideKeyboard();
    }
    expect(composerFocused).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('lets forms and the drawer own focus, including overlapping surfaces and drag dismissal', () => {
    act(() => store.set(windowTraitsAtom, laptopTraits));
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => tree.update(content(true, true)));
    expect(store.get(keyboardFocusBlockersAtom).size).toBe(2);
    hideKeyboard();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(tree.root.findByProps({ children: 'Rename form' })).toBeTruthy();

    act(() => tree.update(content(false, true)));
    expect(store.get(keyboardFocusBlockersAtom).size).toBe(1);
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => tree.update(content()));
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(2);

    act(() => tree.update(content(true)));
    const modal = (tree.root as Queryable).findAll(
      (node) => typeof node.props['onDismiss'] === 'function',
    )[0];
    if (!modal) {
      throw new Error('Expected a presented sheet');
    }
    act(() => (modal.props['onDismiss'] as () => void)());
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(3);
  });

  it('does not focus in the background or another route, then restores focus on return', () => {
    act(() => store.set(windowTraitsAtom, laptopTraits));
    AppState.currentState = 'background';
    flushFocus();
    expect(focus).not.toHaveBeenCalled();
    AppState.currentState = 'active';
    act(() => stateHandlers.forEach((handler) => handler('active')));
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(1);

    mockRouteFocused = false;
    act(() => tree.update(content()));
    dismissKeyboard();
    expect(focus).toHaveBeenCalledTimes(1);
    mockRouteFocused = true;
    act(() => tree.update(content()));
    flushFocus();
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
