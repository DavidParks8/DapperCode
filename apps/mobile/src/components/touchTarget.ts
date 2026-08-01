import { Platform } from 'react-native';

export interface HitSlop {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Platform-effective minimum touch target size, matching Apple's Human Interface Guidelines
 * (44pt) and Android's Material accessibility guidance (48dp). `theme.ts` does not (yet) expose
 * an equivalent `touchTarget` token, so this shared helper computes it directly per-platform;
 * once a `theme.touchTarget.minimum` token exists, callers can prefer that instead.
 */
const PLATFORM_MINIMUM_TOUCH_TARGET: Partial<Record<string, number>> = {
  ios: 44,
  android: 48,
  web: 44,
};

export function resolveMinimumTouchTarget(platformOS: string = Platform.OS): number {
  return PLATFORM_MINIMUM_TOUCH_TARGET[platformOS] ?? 44;
}

/**
 * Computes symmetric `hitSlop` so a visually compact control still resolves to the platform's
 * minimum effective touch target (44pt iOS / 48dp Android) without inflating its visible chrome.
 *
 * `maxHorizontal`/`maxVertical` cap the slop on a given axis so tightly packed sibling controls
 * (chips in a scrollable row, adjacent header buttons) don't gain overlapping hit areas that
 * would steal taps meant for a neighbor.
 */
export function computeHitSlop(
  visibleSize: { width: number; height: number },
  options?: { maxHorizontal?: number; maxVertical?: number },
): HitSlop {
  const minimum = resolveMinimumTouchTarget();
  const verticalSlop = Math.max(0, Math.ceil((minimum - visibleSize.height) / 2));
  const horizontalSlop = Math.max(0, Math.ceil((minimum - visibleSize.width) / 2));
  const vertical =
    options?.maxVertical === undefined ? verticalSlop : Math.min(verticalSlop, options.maxVertical);
  const horizontal =
    options?.maxHorizontal === undefined
      ? horizontalSlop
      : Math.min(horizontalSlop, options.maxHorizontal);

  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}
