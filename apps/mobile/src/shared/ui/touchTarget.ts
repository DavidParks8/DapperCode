import { resolveMinimumTouchTarget, touchTarget } from '@shared/theme';

/**
 * Re-exported so existing call sites can keep importing platform touch-target constants from
 * this shared, chat-owned helper alongside `computeHitSlop`.
 */
export { resolveMinimumTouchTarget, touchTarget };

export interface HitSlop {
  top: number;
  bottom: number;
  left: number;
  right: number;
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
