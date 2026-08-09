import { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  type SharedValue,
} from 'react-native-reanimated';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { repeatingProgress, useChatAnimationTime } from '../animation/ChatAnimationClock';

interface AtomGlyphProps {
  /** Single tone for the whole glyph; the atom never introduces a colour of its own. */
  color: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  active?: boolean;
}

const TAU = Math.PI * 2;

/** Square box, sized to sit inline in a single short status row without crowding the caption. */
const BOX = 20;
/** One full cycle: the shells tip over once while the particles go round them twice. */
const LOOP_DURATION_MS = 2600;
/**
 * Frame held under Reduce Motion. Half way through the loop the core is a crisp hexagon and the six
 * particles are fully extended, one to each of its corners, so it reads as a finished mark rather
 * than a loop caught mid-stride.
 */
const STATIC_PHASE = 0.5;

/**
 * The core is a hexagon that melts into a circle and back. A regular hexagon is exactly the union
 * of three congruent rectangles turned 60 degrees apart: every corner of every rectangle lands on a
 * hexagon vertex, and the six triangles they sweep from the centre tile the hexagon completely.
 * Rounding those rectangles rounds the hexagon's corners away, and at full rounding the three
 * capsules union into a shape within a few percent of a circle — so one animated corner radius
 * carries the whole morph, with no path drawing anywhere.
 */
const BLADE_COUNT = 3;
/** Circumradius of the sharp hexagon; each blade is `sqrt(3)` times as wide as it is tall. */
const HEX_RADIUS = 4.6;
const BLADE_HEIGHT = HEX_RADIUS;
const BLADE_WIDTH = HEX_RADIUS * Math.sqrt(3);
/** Corner radius as a fraction of a blade's height. Half its height is a fully rounded capsule. */
const CORE_ROUND_HEXAGON = 0.06;
const CORE_ROUND_CIRCLE = 0.5;
/**
 * Rounding the corners away costs area, so the circle is grown slightly to keep the core's visual
 * mass steady through the morph rather than appearing to shrink every time it softens.
 */
const CORE_CIRCLE_GROWTH = 1.08;
/** Turns the core makes per loop. A hexagon maps onto itself every sixth of a turn. */
const CORE_TURNS_PER_LOOP = 1 / 3;
/**
 * Bias on the morph. Above one the core spends longer near the hexagon than near the circle, which
 * is the reading the shape is named for; a circle is what everything looks like when it blurs.
 */
const CORE_HEXAGON_DWELL = 1.4;

/** Three shells, two particles each — one at either end of a diameter. */
const SHELL_COUNT = 3;
const PARTICLES_PER_SHELL = 2;
const PARTICLE_COUNT = SHELL_COUNT * PARTICLES_PER_SHELL;
/**
 * Radius the particles orbit at. Wide enough that even the largest near particle clears the core's
 * widest reach, so the two never smear together into one lumpy silhouette.
 */
const ORBIT_RADIUS = 7.4;
const PARTICLE_RADIUS = 1.6;
/** Base square each particle is drawn at; the depth cue is applied as a scale on top. */
const PARTICLE_BASE = PARTICLE_RADIUS * 2;
/** How much nearer particles grow and farther ones shrink. This is the only depth cue there is. */
const DEPTH_SCALE = 0.36;

/**
 * How far a shell foreshortens. At the maximum it is very nearly face on; at the minimum it is all
 * but edge on, so its two particles collapse onto a line through the core.
 */
const SQUASH_MIN = 0.14;
const SQUASH_MAX = 0.95;

/** Revolutions the particles make per loop. Whole turns only, or the loop visibly jumps. */
const REVOLUTIONS_PER_LOOP = 2;

function lerp(from: number, to: number, amount: number): number {
  'worklet';
  return from + (to - from) * amount;
}

/** Zero slope at both ends, so the core dwells on the hexagon and on the circle instead of racing. */
function smoother(amount: number): number {
  'worklet';
  return amount ** 3 * (amount * (amount * 6 - 15) + 10);
}

/**
 * Foreshortening of a shell at a given phase. Each shell runs this on its own offset, so they are
 * never all face on at once and the atom never flattens into a single flat ring.
 */
function squashAt(phase: number, shell: number): number {
  'worklet';
  return lerp(SQUASH_MIN, SQUASH_MAX, 0.5 + 0.5 * Math.cos(TAU * (phase + shell / SHELL_COUNT)));
}

/** 1 where the core is a circle, 0 where it is a hexagon. Once each way per loop. */
function roundnessAt(phase: number): number {
  'worklet';
  return smoother(0.5 + 0.5 * Math.cos(TAU * phase)) ** CORE_HEXAGON_DWELL;
}

interface ParticleProps {
  color: string;
  index: number;
  phase: SharedValue<number>;
  testID: string;
}

/**
 * A point at angle `a` on a circle of radius R, seen from a plane tilted so the circle foreshortens
 * by `squash`, lands at `(R cos a, R sin a * squash)` with depth `R sin a * sqrt(1 - squash^2)`.
 * Turning that ellipse to its shell's fixed tilt finishes the illusion: the particle sweeps behind
 * the core and back out in front of it, growing and shrinking as it goes.
 */
function AtomParticle({ color, index, phase, testID }: ParticleProps) {
  const shell = Math.floor(index / PARTICLES_PER_SHELL);
  const step = index % PARTICLES_PER_SHELL;
  const tilt = (shell * TAU) / SHELL_COUNT;

  const animatedStyle = useAnimatedStyle(() => {
    const squash = squashAt(phase.value, shell);
    const depth = Math.sqrt(Math.max(0, 1 - squash * squash));
    const angle = phase.value * TAU * REVOLUTIONS_PER_LOOP + (step * TAU) / PARTICLES_PER_SHELL;

    const along = Math.cos(angle) * ORBIT_RADIUS;
    const across = Math.sin(angle) * ORBIT_RADIUS * squash;

    return {
      transform: [
        { translateX: along * Math.cos(tilt) - across * Math.sin(tilt) },
        { translateY: along * Math.sin(tilt) + across * Math.cos(tilt) },
        { scale: 1 + DEPTH_SCALE * Math.sin(angle) * depth },
      ],
    };
  });

  return (
    <Animated.View
      testID={testID}
      style={[styles.particle, { backgroundColor: color }, animatedStyle]}
    />
  );
}

interface BladeProps {
  color: string;
  index: number;
  phase: SharedValue<number>;
  testID: string;
}

/** One of the three rectangles whose union is the core. */
function CoreBlade({ color, index, phase, testID }: BladeProps) {
  const offset = (index * Math.PI) / BLADE_COUNT;

  const animatedStyle = useAnimatedStyle(() => {
    const round = roundnessAt(phase.value);
    return {
      borderRadius: lerp(CORE_ROUND_HEXAGON, CORE_ROUND_CIRCLE, round) * BLADE_HEIGHT,
      transform: [
        { rotate: `${String(phase.value * TAU * CORE_TURNS_PER_LOOP + offset)}rad` },
        // Scaling the whole blade takes its corner radius with it, so the morph stays regular.
        { scale: lerp(1, CORE_CIRCLE_GROWTH, round) },
      ],
    };
  });

  return (
    <Animated.View
      testID={testID}
      style={[styles.blade, { backgroundColor: color }, animatedStyle]}
    />
  );
}

/**
 * An atom: a core that melts between a hexagon and a circle, with three shells of particles
 * orbiting it on rings that keep tipping end over end.
 *
 * Everything is drawn with plain views — three rounded rectangles for the core and six circles for
 * the particles — and every one of them is fully opaque and the same tone, so the three rectangles
 * union into a single seamless hexagon, and a particle crossing the core merges into its silhouette
 * the way a moon passing in front of a planet would. Under Reduce Motion the atom holds a static
 * frame instead of looping.
 */
export function AtomGlyph({ color, style, testID = 'atom-glyph', active = true }: AtomGlyphProps) {
  const reduceMotion = useReducedMotion();
  const animationTime = useChatAnimationTime(active && !reduceMotion);
  const phase = useDerivedValue(
    () => (reduceMotion ? STATIC_PHASE : repeatingProgress(animationTime.value, LOOP_DURATION_MS)),
    [animationTime, reduceMotion],
  );
  const blades = useMemo(() => Array.from({ length: BLADE_COUNT }, (_, index) => index), []);
  const particles = useMemo(() => Array.from({ length: PARTICLE_COUNT }, (_, index) => index), []);

  return (
    <View {...decorativeAccessibilityProps} testID={testID} style={[styles.container, style]}>
      {blades.map((index) => (
        <CoreBlade
          key={`atom-blade-${String(index)}`}
          color={color}
          index={index}
          phase={phase}
          testID={`${testID}-blade-${String(index)}`}
        />
      ))}
      {particles.map((index) => (
        <AtomParticle
          key={`atom-particle-${String(index)}`}
          color={color}
          index={index}
          phase={phase}
          testID={`${testID}-particle-${String(index)}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: BOX,
    height: BOX,
  },
  blade: {
    position: 'absolute',
    left: (BOX - BLADE_WIDTH) / 2,
    top: (BOX - BLADE_HEIGHT) / 2,
    width: BLADE_WIDTH,
    height: BLADE_HEIGHT,
  },
  particle: {
    position: 'absolute',
    left: (BOX - PARTICLE_BASE) / 2,
    top: (BOX - PARTICLE_BASE) / 2,
    width: PARTICLE_BASE,
    height: PARTICLE_BASE,
    borderRadius: PARTICLE_BASE / 2,
  },
});
