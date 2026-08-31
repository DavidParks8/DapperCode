import { useMemo } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { Easing, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { motionDuration, motionEasing } from '@shared/ui/motion';

export const MESSAGE_TIMESTAMP_REVEAL_DISTANCE = 72;

export function useMessageTimestampReveal(
  simultaneousGesture: Parameters<typeof Gesture.Simultaneous>[number],
) {
  const translationX = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const revealGesture = useMemo(
    () =>
      Gesture.Pan()
        .withTestId('message-timestamp-reveal-pan')
        .maxPointers(1)
        .activeOffsetX(-10)
        .failOffsetY([-12, 12])
        .onUpdate((event) => {
          translationX.value = Math.max(
            -MESSAGE_TIMESTAMP_REVEAL_DISTANCE,
            Math.min(0, event.translationX),
          );
        })
        .onFinalize(() => {
          translationX.value = withTiming(0, {
            duration: reduceMotion ? 0 : motionDuration.routine,
            easing: Easing.bezier(...motionEasing.standard),
          });
        }),
    [reduceMotion, translationX],
  );
  const gesture = useMemo(
    () => Gesture.Simultaneous(simultaneousGesture, revealGesture),
    [revealGesture, simultaneousGesture],
  );

  return { gesture, translationX };
}
