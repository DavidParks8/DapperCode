import {
  Easing,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { useEffect } from 'react';
import type { ViewStyle } from 'react-native';

import { motion } from '@shared/theme';

export type OnboardingHeroAnimatedStyle = AnimatedStyle<ViewStyle>;
export type OnboardingTranslateAnimatedStyle = AnimatedStyle<ViewStyle>;

/**
 * Drives the one-time intro -> connect handoff: the hero art settles in first, then the
 * "Private connection" action follows a beat later. Restrained (no bounce, single pass) and
 * skipped entirely under Reduce Motion, where both pieces simply appear in their resting state.
 */
export function useOnboardingIntroAnimations(
  showIntroStep: boolean,
  mode: 'initial' | 'edit' | 'add' | 'reconnect',
) {
  const reduceMotion = useReducedMotion();
  const heroProgress = useSharedValue(mode === 'initial' ? 0 : 1);
  const actionsProgress = useSharedValue(mode === 'initial' ? 0 : 1);

  useEffect(() => {
    if (!showIntroStep || reduceMotion) {
      heroProgress.value = 1;
      actionsProgress.value = 1;
      return;
    }

    heroProgress.value = 0;
    actionsProgress.value = 0;
    const timingConfig = {
      reduceMotion: ReduceMotion.System,
      easing: Easing.bezier(...motion.easing.decelerate),
    };
    heroProgress.value = withTiming(1, {
      ...timingConfig,
      duration: motion.duration.layout,
    });
    actionsProgress.value = withDelay(
      motion.duration.layout,
      withTiming(1, { ...timingConfig, duration: motion.duration.routine }),
    );
  }, [actionsProgress, heroProgress, reduceMotion, showIntroStep]);

  const introHeroAnimatedStyle = useAnimatedStyle<ViewStyle>(() => ({
    opacity: heroProgress.value,
    transform: [
      { translateY: interpolate(heroProgress.value, [0, 1], [26, 0]) },
      { scale: interpolate(heroProgress.value, [0, 1], [0.98, 1]) },
    ],
  }));
  const introActionsAnimatedStyle = useAnimatedStyle<ViewStyle>(() => ({
    opacity: actionsProgress.value,
    transform: [{ translateY: interpolate(actionsProgress.value, [0, 1], [18, 0]) }],
  }));

  return {
    introHeroAnimatedStyle,
    introActionsAnimatedStyle,
  };
}
