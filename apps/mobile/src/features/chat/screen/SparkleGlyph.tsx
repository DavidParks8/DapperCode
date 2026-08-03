import { useEffect, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { decorativeAccessibilityProps } from '@shared/accessibility';

interface SparkleGlyphProps {
  /** Single tone for the whole glyph; the sparkle never introduces a colour of its own. */
  color: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const TAU = Math.PI * 2;

/** Square box, sized to sit inline in a single short status row without crowding the caption. */
const BOX = 20;
/** One full cycle: the sparkle turns a half turn, flares, and settles. */
const LOOP_DURATION_MS = 2400;
/**
 * Frame held under Reduce Motion. Mid-cycle is the sparkle at full size with its arms square to
 * the row and the dust spread evenly around it, so it reads as a finished mark rather than a
 * loop caught mid-stride.
 */
const STATIC_PHASE = 0.5;

/**
 * The sparkle is two crossed lozenges. A lozenge is an affine image of a square, so each one is a
 * single rounded `View` turned 45 degrees and then scaled unevenly: long along its arm, narrow
 * across its waist. Rounding is applied to the square *before* the transform, so the tips come out
 * softened but still pointed, and the two arms meet in the concave notches that make the shape read
 * as a sparkle rather than a plus.
 */
const ARM_BASE = 10;
/** Corner radius as a fraction of the base square's half-extent. Higher values chop the tips flat. */
const ARM_ROUNDNESS = 0.16;
const ARM_RADIUS = (ARM_ROUNDNESS * ARM_BASE) / 2;
/** Half-length of an arm, from the centre to a tip, at rest and at full flare. */
const ARM_MIN = 6.2;
const ARM_MAX = 9.4;
/** Half-width at the waist. Around a fifth of the arm length reads as a sparkle, not a star. */
const WAIST_MIN = 1.3;
const WAIST_MAX = 2.1;

/** Motes of dust shaken loose as the sparkle turns. */
const DUST_COUNT = 5;
const DUST_BASE = 4;
const DUST_RADIUS_START = 1.8;
const DUST_RADIUS_END = 0.7;
const DUST_ORBIT_START = 3.4;
const DUST_ORBIT_END = 9.2;
/** Turns of curl over a mote's life, so it drifts outward on an arc rather than a straight line. */
const DUST_CURL = 0.18;
const DUST_FADE_IN = 0.15;

function lerp(from: number, to: number, amount: number): number {
  'worklet';
  return from + (to - from) * amount;
}

/** Rises to 1 at mid-cycle and falls back to 0, so the flare peaks once per loop. */
function flare(phase: number): number {
  'worklet';
  return Math.sin(phase * Math.PI);
}

/**
 * Eased half turn. Its velocity is zero at both ends, so the sparkle spins up and settles rather
 * than rotating at a constant rate — and because a four-armed sparkle maps onto itself every
 * quarter turn, a half turn returns it to its starting silhouette and the loop is seamless.
 */
function turn(phase: number): number {
  'worklet';
  const eased = phase < 0.5 ? 4 * phase ** 3 : 1 - (-2 * phase + 2) ** 3 / 2;
  return eased * Math.PI;
}

interface ArmProps {
  color: string;
  phase: SharedValue<number>;
  /** `true` for the arm that runs up the box, `false` for the one across it. */
  upright: boolean;
  testID: string;
}

function SparkleArm({ color, phase, upright, testID }: ArmProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const open = flare(phase.value);
    // A 45 degree turn maps the base square's corners onto the axes, so its half-diagonal is
    // `ARM_BASE / sqrt(2)`. Scaling from there gives the arm and waist their real lengths.
    const along = (lerp(ARM_MIN, ARM_MAX, open) * Math.SQRT2) / ARM_BASE;
    const across = (lerp(WAIST_MIN, WAIST_MAX, open) * Math.SQRT2) / ARM_BASE;
    return {
      transform: [
        { rotate: `${String(turn(phase.value))}rad` },
        { scaleX: upright ? across : along },
        { scaleY: upright ? along : across },
        { rotate: '45deg' },
      ],
    };
  });

  return (
    <Animated.View
      testID={testID}
      style={[styles.arm, { backgroundColor: color }, animatedStyle]}
    />
  );
}

interface MoteProps {
  color: string;
  index: number;
  phase: SharedValue<number>;
  testID: string;
}

function DustMote({ color, index, phase, testID }: MoteProps) {
  const animatedStyle = useAnimatedStyle(() => {
    // A mote's angle depends only on its own wrapped life, never on the sparkle's rotation, so the
    // ring of dust lands exactly where it started and the loop does not jump.
    const life = (phase.value + index / DUST_COUNT) % 1;
    const angle = (index / DUST_COUNT + life * DUST_CURL) * TAU;
    const orbit = lerp(DUST_ORBIT_START, DUST_ORBIT_END, life);
    const radius = lerp(DUST_RADIUS_START, DUST_RADIUS_END, life);
    return {
      // Fades in as it separates from the sparkle, then thins out as it drifts away.
      opacity: Math.min(life / DUST_FADE_IN, 1) * (1 - life) ** 1.2,
      transform: [
        { translateX: Math.cos(angle) * orbit },
        // Screen Y runs downward, so the orbit's vertical component is negated.
        { translateY: -Math.sin(angle) * orbit },
        { scale: (radius * 2) / DUST_BASE },
      ],
    };
  });

  return (
    <Animated.View
      testID={testID}
      style={[styles.mote, { backgroundColor: color }, animatedStyle]}
    />
  );
}

/**
 * A four-armed sparkle that spins up, flares, and settles, shaking motes of dust loose as it turns.
 *
 * Everything is drawn with plain rounded views: two crossed lozenges for the sparkle and five
 * circles for the dust, seven views in total. Under Reduce Motion the sparkle holds a static frame
 * at full size instead of looping.
 */
export function SparkleGlyph({ color, style, testID = 'sparkle-glyph' }: SparkleGlyphProps) {
  const reduceMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const motes = useMemo(() => Array.from({ length: DUST_COUNT }, (_, index) => index), []);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(phase);
      phase.value = STATIC_PHASE;
      return;
    }

    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: LOOP_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(phase);
    };
  }, [phase, reduceMotion]);

  return (
    <View {...decorativeAccessibilityProps} testID={testID} style={[styles.container, style]}>
      {motes.map((index) => (
        <DustMote
          key={`sparkle-mote-${String(index)}`}
          color={color}
          index={index}
          phase={phase}
          testID={`${testID}-mote-${String(index)}`}
        />
      ))}
      <SparkleArm color={color} phase={phase} upright testID={`${testID}-arm-upright`} />
      <SparkleArm color={color} phase={phase} upright={false} testID={`${testID}-arm-across`} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: BOX,
    height: BOX,
  },
  arm: {
    position: 'absolute',
    left: (BOX - ARM_BASE) / 2,
    top: (BOX - ARM_BASE) / 2,
    width: ARM_BASE,
    height: ARM_BASE,
    borderRadius: ARM_RADIUS,
  },
  mote: {
    position: 'absolute',
    left: (BOX - DUST_BASE) / 2,
    top: (BOX - DUST_BASE) / 2,
    width: DUST_BASE,
    height: DUST_BASE,
    borderRadius: DUST_BASE / 2,
  },
});
