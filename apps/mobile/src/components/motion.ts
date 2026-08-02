import { motion } from '../theme';

/**
 * Ergonomic re-exports of the canonical `theme.motion` tokens (durations in milliseconds, easing
 * as cubic-bezier control points matching Reanimated's `Easing.bezier(x1, y1, x2, y2)`), so
 * call sites can `import { motionDuration, motionEasing } from './motion'` without threading
 * `theme` through every animation call site.
 */
export const motionDuration = motion.duration;
export const motionEasing = motion.easing;
