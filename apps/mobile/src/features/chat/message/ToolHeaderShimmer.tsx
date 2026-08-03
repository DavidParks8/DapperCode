import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

const SHIMMER_SPEED_POINTS_PER_SECOND = 320;
const REDUCED_MOTION_PULSE_MS = 1200;
/**
 * React Native cannot mask a gradient onto glyphs without a native mask view, so the highlight is
 * built from stacked copies of the header text clipped to progressively narrower travelling
 * windows. Only glyph pixels get brighter; the row background is never painted.
 */
const SHIMMER_PASSES = [
  { width: 180, opacity: 0.08 },
  { width: 132, opacity: 0.12 },
  { width: 88, opacity: 0.18 },
  { width: 52, opacity: 0.26 },
  { width: 24, opacity: 0.34 },
];
const SHIMMER_TRAVEL_WIDTH = Math.max(...SHIMMER_PASSES.map((pass) => pass.width));

interface ShimmerPassProps {
  containerHeight: number;
  containerWidth: number;
  contentStyle: StyleProp<ViewStyle>;
  progress: SharedValue<number>;
  children: ReactNode;
}

function ShimmerSweepPass({
  containerHeight,
  containerWidth,
  contentStyle,
  pass,
  progress,
  children,
}: ShimmerPassProps & { pass: (typeof SHIMMER_PASSES)[number] }) {
  const travel = containerWidth + SHIMMER_TRAVEL_WIDTH;
  // Every pass shares one centre so the narrow passes stack in the middle of the wide ones.
  const inset = (SHIMMER_TRAVEL_WIDTH - pass.width) / 2;
  const windowStyle = useAnimatedStyle(() => ({
    opacity: pass.opacity,
    transform: [{ translateX: -SHIMMER_TRAVEL_WIDTH + inset + progress.value * travel }],
  }));
  const copyStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: SHIMMER_TRAVEL_WIDTH - inset - progress.value * travel }],
  }));

  return (
    <Animated.View
      testID="tool-header-shimmer-window"
      style={[styles.sweepWindow, { width: pass.width }, windowStyle]}
    >
      <Animated.View
        testID="tool-header-shimmer-copy"
        style={[
          styles.sweepCopy,
          contentStyle,
          { width: containerWidth, height: containerHeight },
          copyStyle,
        ]}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

function ShimmerPulsePass({
  contentStyle,
  progress,
  children,
}: Omit<ShimmerPassProps, 'containerHeight' | 'containerWidth'>) {
  const pulseStyle = useAnimatedStyle(() => ({ opacity: 0.16 + progress.value * 0.32 }));

  return (
    <Animated.View
      testID="tool-header-shimmer-copy"
      style={[styles.pulseCopy, contentStyle, pulseStyle]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Highlight overlay for a running tool row. It must be rendered inside the same container as the
 * header text and receive that container's inner layout style so the copies land exactly on top of
 * the real glyphs.
 */
export function ToolHeaderShimmer({
  active,
  contentStyle,
  children,
}: {
  active: boolean;
  contentStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!active || (!reduceMotion && size.width <= 0)) {
      cancelAnimation(progress);
      progress.value = 0;
      return;
    }
    const duration = reduceMotion
      ? REDUCED_MOTION_PULSE_MS
      : ((size.width + SHIMMER_TRAVEL_WIDTH) / SHIMMER_SPEED_POINTS_PER_SECOND) * 1000;
    progress.value = withRepeat(
      withTiming(1, {
        duration,
        easing: reduceMotion ? Easing.inOut(Easing.ease) : Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      reduceMotion,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(progress);
  }, [active, progress, reduceMotion, size.width]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  if (!active) {
    return null;
  }
  return (
    <View
      testID="tool-header-shimmer"
      style={styles.overlay}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={onLayout}
    >
      {reduceMotion ? (
        <ShimmerPulsePass contentStyle={contentStyle} progress={progress}>
          {children}
        </ShimmerPulsePass>
      ) : size.width > 0 ? (
        SHIMMER_PASSES.map((pass) => (
          <ShimmerSweepPass
            key={pass.width}
            containerHeight={size.height}
            containerWidth={size.width}
            contentStyle={contentStyle}
            pass={pass}
            progress={progress}
          >
            {children}
          </ShimmerSweepPass>
        ))
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sweepWindow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
  sweepCopy: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  pulseCopy: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
});
