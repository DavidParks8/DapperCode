import { Easing } from 'react-native-reanimated';

/**
 * Restrained motion tokens for the onboarding flow. `theme.motion` (duration/easing scales) is
 * planned as a shared design-system foundation but is not yet present on `AppTheme`, so these
 * mirror its intended values locally until that lands; migrate call sites to `theme.motion`
 * directly once it does. Every duration favors a short, single-pass settle — no bounce, no
 * looping — matching the product's restrained motion language.
 */
export const onboardingMotion = {
  duration: {
    /** Micro-interactions: toggles, small highlight changes. */
    immediate: 120,
    /** Standard content transitions: banners, status changes. */
    routine: 200,
    /** Larger layout handoffs: intro hero reveal, step transitions. */
    layout: 280,
  },
  easing: {
    decelerate: Easing.bezier(0.16, 1, 0.3, 1),
  },
};
