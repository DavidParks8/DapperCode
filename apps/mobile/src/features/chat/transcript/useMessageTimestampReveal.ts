import { usePanGesture, useSimultaneousGestures } from 'react-native-gesture-handler';
import { Easing, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { motion } from '@shared/theme';

export const MESSAGE_TIMESTAMP_REVEAL_DISTANCE = 72;

export function useMessageTimestampReveal(simultaneousGesture: ReturnType<typeof usePanGesture>) {
  const translationX = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const revealGesture = usePanGesture({
    testID: 'message-timestamp-reveal-pan',
    maxPointers: 1,
    activeOffsetX: -10,
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      'worklet';
      translationX.value = Math.max(
        -MESSAGE_TIMESTAMP_REVEAL_DISTANCE,
        Math.min(0, event.translationX),
      );
    },
    onFinalize: () => {
      'worklet';
      translationX.value = withTiming(0, {
        duration: reduceMotion ? 0 : motion.duration.routine,
        easing: Easing.bezier(...motion.easing.standard),
      });
    },
  });
  const gesture = useSimultaneousGestures(simultaneousGesture, revealGesture);

  return { gesture, translationX };
}
