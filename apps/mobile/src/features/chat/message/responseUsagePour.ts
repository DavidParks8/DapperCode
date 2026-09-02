/**
 * The response usage panel pours out of the info button it is anchored to rather than blinking
 * into place: a bead of glass leaves the button, stretches along the axis it travels, spreads into
 * the panel's width a beat later, and only then fills with its readings.
 *
 * Every value here is shared with `ResponseUsageOverlay` so the retention window that keeps a
 * dismissed panel mounted stays tied to the exit it is covering for.
 */

import { useEffect } from 'react';
import type { ViewStyle } from 'react-native';
import {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { motion } from '@shared/theme';
import type { ResponseUsageAnchor } from '../state/modals';

/** How small the glass is when it is still a bead sitting on its button. */
export const POUR_START_SCALE = 0.26;

/**
 * The shell fades between this floor and full and never to zero: UIKit stops rendering the glass
 * material the moment the view or one of its ancestors reaches zero opacity.
 */
export const POUR_MIN_SHELL_OPACITY = 0.12;

/** How far the readings sit toward the anchor before they settle into the formed shape. */
export const POUR_CONTENT_OFFSET = 10;

/** The width trails the length, which is what reads as liquid rather than as a zoom. */
const POUR_SPREAD_DELAY_MS = 45;

/** The readings arrive after the shape that holds them, so the panel forms before it fills. */
const POUR_FILL_DELAY_MS = 90;

/** How long a dismissed panel takes to retract into its button, and so how long it stays mounted. */
export const POUR_EXIT_MS = motion.duration.routine;

const REACH_SPRING = {
  damping: 17,
  stiffness: 220,
  mass: 0.7,
  reduceMotion: ReduceMotion.System,
} as const;

const SPREAD_SPRING = {
  damping: 18,
  stiffness: 145,
  mass: 0.95,
  reduceMotion: ReduceMotion.System,
} as const;

const SHELL_FADE_IN = {
  duration: motion.duration.immediate,
  easing: Easing.bezier(...motion.easing.decelerate),
  reduceMotion: ReduceMotion.System,
} as const;

const CONTENT_SETTLE = {
  duration: motion.duration.routine,
  easing: Easing.bezier(...motion.easing.decelerate),
  reduceMotion: ReduceMotion.System,
} as const;

const SHAPE_RETRACT = {
  duration: POUR_EXIT_MS,
  easing: Easing.bezier(...motion.easing.accelerate),
  reduceMotion: ReduceMotion.System,
} as const;

const CONTENT_RETRACT = {
  duration: motion.duration.immediate,
  easing: Easing.bezier(...motion.easing.accelerate),
  reduceMotion: ReduceMotion.System,
} as const;

interface PourValues {
  scaleX: SharedValue<number>;
  scaleY: SharedValue<number>;
  shellOpacity: SharedValue<number>;
  contentOpacity: SharedValue<number>;
  contentOffset: SharedValue<number>;
}

/**
 * Parks the panel as an unpoured bead. Used before the anchor and the panel's own size are known,
 * which is the window the panel spends waiting off screen.
 */
function applyPourStart(values: PourValues, contentOffset: number): void {
  values.scaleX.value = POUR_START_SCALE;
  values.scaleY.value = POUR_START_SCALE;
  values.shellOpacity.value = POUR_MIN_SHELL_OPACITY;
  values.contentOpacity.value = 0;
  values.contentOffset.value = contentOffset;
}

/** Pours the bead into the measured panel. */
function applyPourEnter(values: PourValues): void {
  values.scaleY.value = withSpring(1, REACH_SPRING);
  values.scaleX.value = withDelay(POUR_SPREAD_DELAY_MS, withSpring(1, SPREAD_SPRING));
  values.shellOpacity.value = withTiming(1, SHELL_FADE_IN);
  values.contentOpacity.value = withDelay(POUR_FILL_DELAY_MS, withTiming(1, CONTENT_SETTLE));
  values.contentOffset.value = withDelay(POUR_FILL_DELAY_MS, withTiming(0, CONTENT_SETTLE));
}

/** Draws the panel back into the button it came from. */
function applyPourExit(values: PourValues, contentOffset: number): void {
  values.scaleX.value = withTiming(POUR_START_SCALE, SHAPE_RETRACT);
  values.scaleY.value = withTiming(POUR_START_SCALE, SHAPE_RETRACT);
  values.shellOpacity.value = withTiming(POUR_MIN_SHELL_OPACITY, SHAPE_RETRACT);
  values.contentOpacity.value = withTiming(0, CONTENT_RETRACT);
  values.contentOffset.value = withTiming(contentOffset, CONTENT_RETRACT);
}

/**
 * Which way the readings travel as they settle: always out of the anchor, so a panel above its
 * button lifts its contents up into place and a flipped one drops them down.
 */
export function resolvePourContentOffset(placedAbove: boolean): number {
  return placedAbove ? POUR_CONTENT_OFFSET : -POUR_CONTENT_OFFSET;
}

/**
 * The point the panel grows out of, in panel-local coordinates: the edge nearest the button, under
 * the button's centre. Scaling about anywhere else makes the glass appear beside its anchor rather
 * than out of it.
 */
export function resolvePourOrigin({
  anchor,
  left,
  panel,
  placedAbove,
}: {
  anchor: ResponseUsageAnchor | null;
  left: number;
  panel: { width: number; height: number } | null;
  placedAbove: boolean;
}): { x: number; y: number } {
  const width = panel?.width ?? 0;
  const height = panel?.height ?? 0;
  if (!anchor) {
    return { x: width / 2, y: height / 2 };
  }
  const anchorCenterX = anchor.x + anchor.width / 2;
  const x = Math.min(Math.max(anchorCenterX - left, 0), width);
  return { x, y: placedAbove ? height : 0 };
}

type PourStyle = ReturnType<typeof useAnimatedStyle<ViewStyle>>;

/**
 * Drives one panel's pour, from the bead it waits as while it is still being placed through to the
 * retraction that covers its dismissal.
 */
export function useResponseUsagePour({
  closing,
  contentOffset,
  overlayId,
  placed,
}: {
  closing: boolean;
  contentOffset: number;
  overlayId: string | undefined;
  placed: boolean;
}): { shellStyle: PourStyle; contentStyle: PourStyle } {
  const scaleX = useSharedValue(POUR_START_SCALE);
  const scaleY = useSharedValue(POUR_START_SCALE);
  const shellOpacity = useSharedValue(POUR_MIN_SHELL_OPACITY);
  const contentOpacity = useSharedValue(0);
  const pourOffset = useSharedValue(contentOffset);

  useEffect(() => {
    const values: PourValues = {
      scaleX,
      scaleY,
      shellOpacity,
      contentOpacity,
      contentOffset: pourOffset,
    };
    if (closing) {
      applyPourExit(values, contentOffset);
      return;
    }
    // Until it is placed the panel waits off screen, so it holds there as an unpoured bead instead
    // of spending its pour where nobody can see it and arriving already formed.
    if (!placed) {
      applyPourStart(values, contentOffset);
      return;
    }
    applyPourEnter(values);
  }, [
    closing,
    contentOffset,
    contentOpacity,
    overlayId,
    placed,
    pourOffset,
    scaleX,
    scaleY,
    shellOpacity,
  ]);

  const shellStyle = useAnimatedStyle(() => ({
    opacity: shellOpacity.value,
    transform: [{ scaleX: scaleX.value }, { scaleY: scaleY.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
    transform: [{ translateY: pourOffset.value }],
  }));

  return { shellStyle, contentStyle };
}
