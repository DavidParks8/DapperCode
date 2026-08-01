import { Platform } from 'react-native';

export interface TouchInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Effective minimum touch target size: 44pt on iOS (Apple HIG), 48dp on Android (Material), 44 as
 * a reasonable default elsewhere. `theme.touchTarget.minimum` is planned as a shared design-system
 * foundation but is not yet present on `AppTheme`; this mirrors its intended resolution locally
 * until that lands. Migrate call sites to `theme.touchTarget.minimum` directly once it does.
 */
export const TOUCH_TARGET_MINIMUM = Platform.select({ ios: 44, android: 48, default: 44 });

/**
 * Pads a visually compact control (an icon-only button drawn smaller than the platform's
 * minimum touch target) out to `TOUCH_TARGET_MINIMUM` on every edge via `hitSlop`, without
 * growing the control's visual footprint.
 */
export function hitSlopToMeetMinimum(visualSize: number): TouchInset {
  const pad = Math.max(0, Math.ceil((TOUCH_TARGET_MINIMUM - visualSize) / 2));
  return { top: pad, bottom: pad, left: pad, right: pad };
}
