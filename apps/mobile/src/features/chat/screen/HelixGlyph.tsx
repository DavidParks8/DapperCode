import { useEffect, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { decorativeAccessibilityProps } from '@shared/accessibility';

interface HelixGlyphProps {
  /** Color of the strand that starts in front. */
  color: string;
  /** Color of the counter-strand; defaults to `color` for a single-tone helix. */
  secondaryColor?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const TAU = Math.PI * 2;

/** Glyph box, sized to sit inline in a single short status row. */
const WIDTH = 26;
const HEIGHT = 14;
/**
 * Sample columns along each strand. Dense enough that neighboring dots overlap, so a strand reads
 * as a continuous ribbon instead of a row of separate dots.
 */
const NODE_COUNT = 11;
const DOT_SIZE = 2.8;
const AMPLITUDE = 5;
/** Revolutions of the helix across the full width of the glyph. */
const TWIST = 1;
/** One full revolution. Slow enough that the depth ordering reads as rotation, not shimmer. */
const ROTATION_DURATION_MS = 1900;
/**
 * Frame held under Reduce Motion. An eighth of a turn puts a crossing inside the glyph with a full
 * lobe either side, so the silhouette still reads as a helix without any motion to explain it.
 */
const STATIC_PHASE = 0.125;

/**
 * Depth cues. A helix drawn side-on is flat, so the illusion of rotation comes entirely from
 * the far half of each strand being smaller and dimmer than the near half. The spread is wide
 * enough that the near strand clearly dominates, but the floor keeps the far strand visible on
 * a light background so the glyph still reads as a *double* helix.
 */
const DEPTH_SCALE_MIN = 0.44;
const DEPTH_SCALE_MAX = 1.16;
const DEPTH_OPACITY_MIN = 0.2;
const DEPTH_OPACITY_MAX = 1;

const COLUMN_STEP = (WIDTH - DOT_SIZE) / (NODE_COUNT - 1);

/** Angle of a column at a given phase, shared by every dot in that column. */
function columnAngle(phase: number, index: number): number {
  'worklet';
  return TAU * (phase + (index * TWIST) / NODE_COUNT);
}

interface StrandDotProps {
  color: string;
  index: number;
  /** Which paint layer this dot belongs to; the other layer holds it at zero opacity. */
  layer: 'near' | 'far';
  phase: SharedValue<number>;
  /** `1` for the strand that starts in front, `-1` for its counter-strand. */
  strand: 1 | -1;
  testID: string;
}

/**
 * One dot of one strand, pinned to a single paint layer. React Native has no animatable z-order,
 * so each strand is rendered twice — once behind the pair and once in front — and only the copy
 * matching the strand's current depth is visible. That is what lets the near dot occlude the far
 * one as they cross, which keeps the crossings clean rather than muddy.
 */
function StrandDot({ color, index, layer, phase, strand, testID }: StrandDotProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const angle = columnAngle(phase.value, index);
    const depth = Math.cos(angle) * strand;
    const isNear = depth >= 0;
    const visible = layer === 'near' ? isNear : !isNear;
    return {
      opacity: visible ? interpolate(depth, [-1, 1], [DEPTH_OPACITY_MIN, DEPTH_OPACITY_MAX]) : 0,
      transform: [
        { translateY: AMPLITUDE * Math.sin(angle) * strand },
        { scale: interpolate(depth, [-1, 1], [DEPTH_SCALE_MIN, DEPTH_SCALE_MAX]) },
      ],
    };
  });

  return (
    <Animated.View
      testID={testID}
      style={[styles.node, { backgroundColor: color }, animatedStyle]}
    />
  );
}

interface HelixColumnProps {
  color: string;
  index: number;
  phase: SharedValue<number>;
  secondaryColor: string;
  testID: string;
}

function HelixColumn({ color, index, phase, secondaryColor, testID }: HelixColumnProps) {
  const dotProps = { index, phase } as const;

  return (
    <View style={[styles.column, { left: index * COLUMN_STEP }]}>
      <StrandDot
        {...dotProps}
        color={color}
        layer="far"
        strand={1}
        testID={`${testID}-a-far-${String(index)}`}
      />
      <StrandDot
        {...dotProps}
        color={secondaryColor}
        layer="far"
        strand={-1}
        testID={`${testID}-b-far-${String(index)}`}
      />
      <StrandDot
        {...dotProps}
        color={color}
        layer="near"
        strand={1}
        testID={`${testID}-a-near-${String(index)}`}
      />
      <StrandDot
        {...dotProps}
        color={secondaryColor}
        layer="near"
        strand={-1}
        testID={`${testID}-b-near-${String(index)}`}
      />
    </View>
  );
}

/**
 * A rotating DNA double helix, sized for a single short status row.
 *
 * Two strands of dots ride offset sine paths while their depth drives scale, opacity, and paint
 * order, which is what sells the rotation without any 3D or SVG support. Under Reduce Motion the
 * helix holds a static frame that still reads as a helix instead of looping.
 */
export function HelixGlyph({
  color,
  secondaryColor,
  style,
  testID = 'helix-glyph',
}: HelixGlyphProps) {
  const reduceMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const columns = useMemo(() => Array.from({ length: NODE_COUNT }, (_, index) => index), []);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(phase);
      phase.value = STATIC_PHASE;
      return;
    }

    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: ROTATION_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(phase);
    };
  }, [phase, reduceMotion]);

  return (
    <View {...decorativeAccessibilityProps} testID={testID} style={[styles.container, style]}>
      {columns.map((index) => (
        <HelixColumn
          key={`helix-column-${String(index)}`}
          color={color}
          index={index}
          phase={phase}
          secondaryColor={secondaryColor ?? color}
          testID={testID}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: WIDTH,
    height: HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  column: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: DOT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  node: {
    position: 'absolute',
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
});
