import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { isReduceMotionPreferred } from '@shared/feedback';

/**
 * Live Reduce Motion preference for chat surfaces that still animate with the legacy RN
 * `Animated` API (which has no equivalent to Reanimated's `.reduceMotion(ReduceMotion.System)`
 * modifier). Reanimated-driven components should prefer that modifier directly; this hook exists
 * for the handful of surfaces, like `LoadingGlyph`, that predate Reanimated and loop continuously.
 *
 * Starts `false` and resolves the real preference on mount, then stays in sync with
 * `AccessibilityInfo`'s change event so a mid-session toggle is honored without a remount.
 */
export function useReduceMotionPreference(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void isReduceMotionPreferred().then((value) => {
      if (!cancelled) {
        setReduceMotion(value);
      }
    });

    if (typeof AccessibilityInfo.addEventListener !== 'function') {
      return () => {
        cancelled = true;
      };
    }

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduceMotion(value);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
