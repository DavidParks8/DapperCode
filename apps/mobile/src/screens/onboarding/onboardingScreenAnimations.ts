import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing } from 'react-native';

export interface OnboardingHeroAnimatedStyle {
  opacity: Animated.Value;
  transform: [
    { translateY: Animated.AnimatedInterpolation<string | number> },
    { scale: Animated.AnimatedInterpolation<string | number> },
  ];
}

export interface OnboardingTranslateAnimatedStyle {
  opacity: Animated.Value;
  transform: [{ translateY: Animated.AnimatedInterpolation<string | number> }];
}

export function useOnboardingIntroAnimations(showIntroStep: boolean, mode: 'initial' | 'edit' | 'add' | 'reconnect') {
  const introHeroMotion = useRef(new Animated.Value(mode === 'initial' ? 0 : 1)).current;
  const introActionsMotion = useRef(new Animated.Value(mode === 'initial' ? 0 : 1)).current;

  useEffect(() => {
    if (!showIntroStep) {
      introHeroMotion.setValue(1);
      introActionsMotion.setValue(1);
      return;
    }

    introHeroMotion.setValue(0);
    introActionsMotion.setValue(0);
    Animated.sequence([
      Animated.timing(introHeroMotion, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(introActionsMotion, {
        toValue: 1,
        duration: 340,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [introActionsMotion, introHeroMotion, showIntroStep]);

  const introHeroAnimatedStyle = useMemo<OnboardingHeroAnimatedStyle>(
    () => ({
      opacity: introHeroMotion,
      transform: [
        {
          translateY: introHeroMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [26, 0],
          }),
        },
        {
          scale: introHeroMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [0.98, 1],
          }),
        },
      ],
    }),
    [introHeroMotion]
  );
  const introActionsAnimatedStyle = useMemo<OnboardingTranslateAnimatedStyle>(
    () => ({
      opacity: introActionsMotion,
      transform: [
        {
          translateY: introActionsMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [18, 0],
          }),
        },
      ],
    }),
    [introActionsMotion]
  );
  return {
    introHeroAnimatedStyle,
    introActionsAnimatedStyle,
  };
}
