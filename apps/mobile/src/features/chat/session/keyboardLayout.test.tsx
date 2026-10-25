import { Dimensions, Keyboard, type KeyboardEvent } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { resolveKeyboardInset, useKeyboardFrameTracking } from './keyboardLayout';

describe('resolveKeyboardInset', () => {
  it('uses the keyboard top edge to preserve the actual app overlap', () => {
    // Captured by the iPhone 17e Appium regression: screen 844, keyboard begins at y=553.
    expect(resolveKeyboardInset(844, 553, 233)).toBe(291);
  });

  it('falls back to the reported keyboard height when its top edge is unavailable', () => {
    expect(resolveKeyboardInset(844, undefined, 233)).toBe(233);
  });

  it('never produces a negative inset from an off-screen keyboard frame', () => {
    expect(resolveKeyboardInset(844, 900, 233)).toBe(0);
  });
});

describe('useKeyboardFrameTracking', () => {
  const handlers = new Map<string, (event: KeyboardEvent) => void>();
  const setVisible = jest.fn();
  const setInset = jest.fn();

  function Probe() {
    useKeyboardFrameTracking(setVisible, setInset);
    return null;
  }

  beforeEach(() => {
    handlers.clear();
    setVisible.mockClear();
    setInset.mockClear();
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, handler) => {
      handlers.set(name, handler);
      return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Dimensions.set({
      window: { width: 750, height: 1334, scale: 2, fontScale: 1 },
      screen: { width: 750, height: 1334, scale: 2, fontScale: 1 },
    });
  });

  it('keeps the composer above the keyboard when the main screen is another display', () => {
    // An open iPhone Duo in the laptop pose: the app window is the 669x951 inner display, React
    // Native's main screen is the 466x678 outer display, and the keyboard fills the lower half
    // from the fold down.
    Dimensions.set({
      window: { width: 669, height: 951, scale: 3, fontScale: 1 },
      screen: { width: 466, height: 678, scale: 3, fontScale: 1 },
    });
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Probe />);
    });

    act(() => {
      handlers.get('keyboardWillShow')?.({
        endCoordinates: { screenX: 0, screenY: 455.5, width: 669, height: 495.5 },
      } as KeyboardEvent);
    });
    expect(setVisible).toHaveBeenLastCalledWith(true);
    expect(setInset).toHaveBeenLastCalledWith(495.5);

    act(() => {
      handlers.get('keyboardWillHide')?.({} as KeyboardEvent);
    });
    expect(setVisible).toHaveBeenLastCalledWith(false);
    expect(setInset).toHaveBeenLastCalledWith(0);

    act(() => tree.unmount());
  });
});
