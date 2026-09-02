import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
} from 'react-native-reanimated';

import { motion } from '@shared/theme';
import type { Chat } from '@bridge/types/types';
import type { ActivityState } from '../helpers/helpers';
import type { ActivityTone } from '../state/runtime';
import { ActivityEvent } from './ActivityEvent';
import { useActivityElapsedMs } from './activityDuration';

export const ACTIVITY_COLLAPSE_DURATION_MS = motion.duration.layout;

/**
 * Only a settled row earns a graceful exit. A live row that disappears has been superseded — by a
 * new turn, another thread, or a lost bridge — and holding a stale "Working" line on screen while
 * it faded would say something that is no longer true.
 */
const COLLAPSIBLE_TONES = new Set<ActivityTone>(['complete', 'error']);

const COLLAPSE_EASING = Easing.bezier(...motion.easing.accelerate);
const COLLAPSE_CONFIG = {
  duration: ACTIVITY_COLLAPSE_DURATION_MS,
  easing: COLLAPSE_EASING,
  reduceMotion: ReduceMotion.System,
} as const;
/**
 * Appearing is the entering fade's job, so the slot only needs to adopt the row's measured height
 * without a transition of its own.
 */
const SETTLE_CONFIG = { duration: 0, reduceMotion: ReduceMotion.System } as const;

export interface CollapsibleActivity {
  activity: ActivityState;
  collapsing: boolean;
}

/**
 * Keeps a settled activity row alive long enough to collapse.
 *
 * The row is the header of an inverted transcript, so dropping it straight out of the tree removed
 * a whole line of layout in one frame and snapped every message down with it. This hook keeps
 * handing back the last settled activity, flagged as collapsing, until the animation has had its
 * time; it returns `null` — exactly as before — whenever there is genuinely nothing to render.
 */
export function useCollapsibleActivity(activity: ActivityState | null): CollapsibleActivity | null {
  const retainedRef = useRef<ActivityState | null>(null);
  if (activity) {
    retainedRef.current = activity;
  }
  const retained = retainedRef.current;
  const collapsible = Boolean(retained && COLLAPSIBLE_TONES.has(retained.tone));
  const [cleared, setCleared] = useState(true);
  const shouldClearImmediately = !activity && !collapsible;
  if (activity && cleared) {
    setCleared(false);
  } else if (shouldClearImmediately && !cleared) {
    setCleared(true);
  }
  const settled = cleared || shouldClearImmediately;
  const collapsing = !activity && !settled;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!collapsing) {
      return undefined;
    }
    if (reducedMotion) {
      setCleared(true);
      return undefined;
    }
    const timer = setTimeout(() => setCleared(true), ACTIVITY_COLLAPSE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [collapsing, reducedMotion]);

  if (!retained || (!activity && settled)) {
    return null;
  }
  return { activity: retained, collapsing };
}

/**
 * Renders the transcript's activity row and runs its measured height and opacity down to zero once
 * the row is on its way out.
 */
export function TranscriptActivitySlot({
  chat,
  presentation,
  animationActive,
}: {
  chat: Chat;
  presentation: CollapsibleActivity;
  animationActive: boolean;
}) {
  const { activity, collapsing } = presentation;
  const elapsedMs = useActivityElapsedMs(chat, activity);
  const [contentHeight, setContentHeight] = useState(0);
  const timing = collapsing ? COLLAPSE_CONFIG : SETTLE_CONFIG;
  const animatedStyle = useAnimatedStyle(() => ({
    height: withTiming(collapsing ? 0 : contentHeight, timing),
    opacity: withTiming(collapsing ? 0 : 1, timing),
  }));

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height <= 0) {
      return;
    }
    setContentHeight((previous) => (Math.abs(previous - height) < 0.5 ? previous : height));
  }, []);

  // Before the first measurement the natural height has to win, otherwise the row would be pinned
  // to zero on the frame it appears and never show at all.
  const heightIsKnown = collapsing || contentHeight > 0;

  return (
    <Animated.View
      style={[styles.slot, heightIsKnown ? animatedStyle : null]}
      pointerEvents={collapsing ? 'none' : 'auto'}
      testID="transcript-activity-slot"
    >
      <View onLayout={handleLayout}>
        <ActivityEvent
          {...activity}
          elapsedMs={elapsedMs}
          animationActive={animationActive && !collapsing}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slot: {
    overflow: 'hidden',
  },
});
