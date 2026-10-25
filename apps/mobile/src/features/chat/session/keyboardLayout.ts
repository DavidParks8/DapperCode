import { useEffect } from 'react';
import { Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native';

export function resolveKeyboardInset(
  windowHeight: number,
  keyboardTop: number | undefined,
  keyboardHeight: number | undefined,
): number {
  const normalizedWindowHeight = Number.isFinite(windowHeight) ? Math.max(0, windowHeight) : 0;
  if (typeof keyboardTop === 'number' && Number.isFinite(keyboardTop)) {
    return Math.max(0, normalizedWindowHeight - keyboardTop);
  }
  return typeof keyboardHeight === 'number' && Number.isFinite(keyboardHeight)
    ? Math.max(0, keyboardHeight)
    : 0;
}

/**
 * Publishes how far the keyboard overlaps the app window. The overlap is measured against the
 * window rather than the screen: on devices with more than one display, React Native's screen is
 * the ambiguous main screen, which can be a different display from the one showing the app.
 */
export function useKeyboardFrameTracking(
  setKeyboardVisible: (visible: boolean) => void,
  setKeyboardInset: (inset: number) => void,
): void {
  useEffect(() => {
    const updateKeyboardFrame = (event: KeyboardEvent) => {
      const inset = resolveKeyboardInset(
        Dimensions.get('window').height,
        event.endCoordinates?.screenY,
        event.endCoordinates?.height,
      );
      setKeyboardVisible(inset > 0);
      setKeyboardInset(inset);
    };
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, updateKeyboardFrame);
    const frameSub =
      Platform.OS === 'ios'
        ? Keyboard.addListener('keyboardWillChangeFrame', updateKeyboardFrame)
        : null;
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
      setKeyboardInset(0);
    });
    return () => {
      showSub.remove();
      frameSub?.remove();
      hideSub.remove();
    };
  }, [setKeyboardInset, setKeyboardVisible]);
}
