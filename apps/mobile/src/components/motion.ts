/**
 * Motion tokens for chat-surface micro-interactions. `theme.ts` does not (yet) expose an
 * equivalent `motion` token set, so this shared, chat-owned helper mirrors the intended shape
 * (durations in milliseconds, easing as cubic-bezier control points matching Reanimated's
 * `Easing.bezier(x1, y1, x2, y2)`) so every new animation in this surface stays consistent.
 * Once `theme.motion` exists, callers here should switch to it directly.
 */
export const motionDuration = {
  /** Instant acknowledgements: button press states, toggle flips. */
  immediate: 120,
  /** Everyday transitions: sheet content swaps, fades. */
  routine: 200,
  /** Layout-affecting moves: card enter/exit, expand/collapse reflows. */
  layout: 280,
} as const;

export const motionEasing = {
  standard: [0.4, 0, 0.2, 1],
  decelerate: [0, 0, 0.2, 1],
  accelerate: [0.4, 0, 1, 1],
} as const;
