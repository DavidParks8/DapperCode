import { useFocusEffect } from 'expo-router';
import { useAtomValue, useStore } from 'jotai';
import { useCallback, type RefObject } from 'react';
import { AppState, Keyboard, type TextInput } from 'react-native';

import { useShellLayout } from '@shell/layout/useShellLayout';
import { keyboardFocusBlockersAtom } from '@shell/state/keyboard';

export function useLaptopKeyboard(
  inputRef: RefObject<Pick<TextInput, 'focus' | 'isFocused'> | null>,
): void {
  const laptopMode = useShellLayout().tabletopFold !== null;
  const blocked = useAtomValue(keyboardFocusBlockersAtom).size > 0;
  const store = useStore();

  useFocusEffect(
    useCallback(() => {
      if (!laptopMode || blocked) {
        return;
      }
      let frame: number | null = null;
      const focus = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
        }
        frame = requestAnimationFrame(() => {
          frame = null;
          if (
            AppState.currentState !== 'background' &&
            AppState.currentState !== 'inactive' &&
            store.get(keyboardFocusBlockersAtom).size === 0 &&
            // A system alert hides the keyboard but leaves the composer focused, and UIKit brings
            // the keyboard back when it closes. Refocusing would fight the alert for the keyboard.
            inputRef.current?.isFocused() === false
          ) {
            inputRef.current.focus();
          }
        });
      };
      focus();
      const keyboardSubscription = Keyboard.addListener('keyboardDidHide', focus);
      const appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          focus();
        }
      });
      return () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
        }
        keyboardSubscription.remove();
        appStateSubscription.remove();
      };
    }, [blocked, inputRef, laptopMode, store]),
  );
}
