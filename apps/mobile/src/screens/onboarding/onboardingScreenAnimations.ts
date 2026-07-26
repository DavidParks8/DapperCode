import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';

import {
  INTRO_AGENT_FADE_MS,
  INTRO_AGENT_MARKS,
  INTRO_AGENT_ROTATION_MS,
} from './onboardingScreenConstants';

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
  const [introAgentIndex, setIntroAgentIndex] = useState(0);
  const introHeroMotion = useRef(new Animated.Value(mode === 'initial' ? 0 : 1)).current;
  const introActionsMotion = useRef(new Animated.Value(mode === 'initial' ? 0 : 1)).current;
  const introAgentMotion = useRef(new Animated.Value(1)).current;

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
  const introAgentAnimatedStyle = useMemo<OnboardingTranslateAnimatedStyle>(
    () => ({
      opacity: introAgentMotion,
      transform: [
        {
          translateY: introAgentMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [6, 0],
          }),
        },
      ],
    }),
    [introAgentMotion]
  );

  useEffect(() => {
    if (!showIntroStep) {
      introAgentMotion.stopAnimation();
      introAgentMotion.setValue(1);
      setIntroAgentIndex(0);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      timer = setTimeout(() => {
        Animated.timing(introAgentMotion, {
          toValue: 0,
          duration: INTRO_AGENT_FADE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (!active || !finished) {
            return;
          }
          setIntroAgentIndex((previous) => (previous + 1) % INTRO_AGENT_MARKS.length);
          Animated.timing(introAgentMotion, {
            toValue: 1,
            duration: INTRO_AGENT_FADE_MS + 60,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start(({ finished: fadeInFinished }) => {
            if (active && fadeInFinished) {
              scheduleNext();
            }
          });
        });
      }, INTRO_AGENT_ROTATION_MS);
    };

    introAgentMotion.setValue(1);
    scheduleNext();

    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
      introAgentMotion.stopAnimation();
    };
  }, [introAgentMotion, showIntroStep]);

  return {
    introHeroAnimatedStyle,
    introActionsAnimatedStyle,
    introAgentAnimatedStyle,
    introAgentLabel: INTRO_AGENT_MARKS[introAgentIndex]?.label ?? 'ACP agents',
  };
}
