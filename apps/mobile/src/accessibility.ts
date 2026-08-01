import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  type AccessibilityState,
  type View,
} from 'react-native';

export const decorativeAccessibilityProps = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no' as const,
};

export function useAccessibilityAnnouncement(message: string | null | undefined): void {
  const previousMessageRef = useRef<string | null>(null);

  useEffect(() => {
    const nextMessage = message?.trim() || null;
    if (!nextMessage || nextMessage === previousMessageRef.current) {
      previousMessageRef.current = nextMessage;
      return;
    }

    previousMessageRef.current = nextMessage;
    AccessibilityInfo.announceForAccessibility(nextMessage);
  }, [message]);
}

export function useAccessibilityFocus(active: boolean, delayMs = 350) {
  const focusRef = useRef<View>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    const timeout = setTimeout(() => {
      if (typeof findNodeHandle !== 'function') {
        return;
      }
      try {
        const handle = findNodeHandle(focusRef.current);
        if (typeof handle === 'number') {
          AccessibilityInfo.setAccessibilityFocus(handle);
        }
      } catch {
        // Some platforms (web) throw instead of returning null; focus is best effort.
      }
    }, delayMs);

    return () => clearTimeout(timeout);
  }, [active, delayMs]);

  return focusRef;
}

export const useModalAccessibilityFocus = useAccessibilityFocus;

export function controlAccessibilityState({
  disabled = false,
  selected,
  expanded,
  busy,
}: {
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  busy?: boolean;
}): AccessibilityState {
  return {
    disabled,
    ...(selected === undefined ? null : { selected }),
    ...(expanded === undefined ? null : { expanded }),
    ...(busy === undefined ? null : { busy }),
  };
}
