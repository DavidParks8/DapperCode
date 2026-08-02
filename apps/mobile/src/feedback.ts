import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Semantic tactile feedback actions the product speaks in. Screens should reach for one of
 * these instead of calling `expo-haptics` directly so the mapping to concrete haptic patterns
 * stays centralized and easy to retune.
 */
export type FeedbackAction =
  | 'selection'
  | 'send'
  | 'success'
  | 'warning'
  | 'error'
  | 'destructive';

const HAPTICS_SUPPORTED_PLATFORMS: ReadonlySet<typeof Platform.OS> = new Set(['ios', 'android']);

/** Whether the current platform can play native haptics. Haptics no-op on web. */
export function isHapticsSupportedPlatform(platformOS: typeof Platform.OS = Platform.OS): boolean {
  return HAPTICS_SUPPORTED_PLATFORMS.has(platformOS);
}

/**
 * Expo/Apple/Android surface "unavailable" as a coded error (`ERR_UNAVAILABLE`) rather than a
 * thrown subclass we can import, since expo-modules-core is only a transitive dependency here.
 * We only treat that specific, known "no native haptics engine" shape as a no-op; any other
 * error is a real programming error and must not be swallowed.
 */
function isUnavailableHapticsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_UNAVAILABLE'
  );
}

async function runHaptic(action: () => Promise<void>): Promise<void> {
  if (!isHapticsSupportedPlatform()) {
    return;
  }

  try {
    await action();
  } catch (error) {
    if (isUnavailableHapticsError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Reports the user's Reduce Motion preference. This exists for callers that pair a haptic with
 * an *animation* and want to skip the animation half; it must never be used to suppress the
 * haptic itself. Apple's Taptic Engine is not classified as "motion" by Reduce Motion, and
 * there is no dedicated "reduce haptics" accessibility signal in React Native today, so
 * `feedback` below always fires regardless of this preference.
 */
export async function isReduceMotionPreferred(): Promise<boolean> {
  if (typeof AccessibilityInfo.isReduceMotionEnabled !== 'function') {
    return false;
  }
  return AccessibilityInfo.isReduceMotionEnabled();
}

/**
 * Semantic haptic feedback actions. Every call is best-effort: it silently no-ops on web and on
 * any platform/device that reports haptics as unavailable, but it never swallows unrelated
 * programming errors.
 */
export const feedback: Record<FeedbackAction, () => Promise<void>> = {
  selection: () => runHaptic(() => Haptics.selectionAsync()),
  send: () => runHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: () =>
    runHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () =>
    runHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => runHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  destructive: () => runHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
};
