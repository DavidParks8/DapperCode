import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  FadeIn,
  FadeOut,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useAppTheme, type AppTheme } from '@shared/theme';

const SHIMMER_WIDTH = 180;
const SHIMMER_SPEED_POINTS_PER_SECOND = 430;
const REDUCED_MOTION_PULSE_MS = 1200;
const USER_BUBBLE_WIDTH_RATIO = 0.72;
const USER_BUBBLE_WIDTH = `${USER_BUBBLE_WIDTH_RATIO * 100}%` as `${number}%`;

interface ShimmerBoneProps {
  containerWidth: number;
  offset: number;
  progress: SharedValue<number>;
  reduceMotion: boolean;
  style: StyleProp<ViewStyle>;
  theme: AppTheme;
}

function ShimmerBone({
  containerWidth,
  offset,
  progress,
  reduceMotion,
  style,
  theme,
}: ShimmerBoneProps) {
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.82 + progress.value * 0.18 : 1,
  }));
  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: -SHIMMER_WIDTH + progress.value * (containerWidth + SHIMMER_WIDTH) - offset,
      },
    ],
  }));

  return (
    <Animated.View
      style={[styles.bone, { backgroundColor: theme.colors.borderLight }, pulseStyle, style]}
    >
      {!reduceMotion && containerWidth > 0 ? (
        <Animated.View style={[styles.shimmerBand, shimmerStyle]}>
          <LinearGradient
            colors={[
              theme.colors.transparent,
              theme.colors.borderHighlight,
              theme.colors.transparent,
            ]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={styles.shimmerGradient}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export function SubAgentTranscriptShimmer() {
  const theme = useAppTheme();
  const componentStyles = useMemo(() => createStyles(theme), [theme]);
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const userBubbleOffset = containerWidth * (1 - USER_BUBBLE_WIDTH_RATIO);
  const userContentOffset = userBubbleOffset + theme.spacing.lg;

  useEffect(() => {
    if (containerWidth <= 0) {
      return;
    }

    progress.value = 0;
    const shimmerDurationMs =
      ((containerWidth + SHIMMER_WIDTH) / SHIMMER_SPEED_POINTS_PER_SECOND) * 1000;
    progress.value = reduceMotion
      ? withRepeat(
          withTiming(1, {
            duration: REDUCED_MOTION_PULSE_MS,
            easing: Easing.inOut(Easing.quad),
            reduceMotion: ReduceMotion.Never,
          }),
          -1,
          true,
          undefined,
          ReduceMotion.Never,
        )
      : withRepeat(
          withTiming(1, {
            duration: shimmerDurationMs,
            easing: Easing.linear,
          }),
          -1,
          false,
        );
    return () => {
      cancelAnimation(progress);
    };
  }, [containerWidth, progress, reduceMotion]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);
  const boneProps = {
    containerWidth,
    progress,
    reduceMotion,
    theme,
  };

  return (
    <Animated.View
      testID="agent-transcript-shimmer"
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      style={componentStyles.root}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading agent transcript"
    >
      <View
        style={componentStyles.conversation}
        onLayout={handleLayout}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        <View style={componentStyles.assistantGroup}>
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.lineLong} />
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.lineFull} />
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.lineShort} />
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.activityCard} />
        </View>

        <View style={componentStyles.userBubble}>
          <ShimmerBone
            {...boneProps}
            offset={userContentOffset}
            style={componentStyles.userLineLong}
          />
          <ShimmerBone
            {...boneProps}
            offset={userContentOffset}
            style={componentStyles.userLineShort}
          />
        </View>

        <View style={componentStyles.assistantGroup}>
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.lineMedium} />
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.lineFull} />
          <ShimmerBone {...boneProps} offset={0} style={componentStyles.lineTiny} />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bone: {
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
  },
  shimmerBand: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: SHIMMER_WIDTH,
  },
  shimmerGradient: {
    flex: 1,
  },
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: 1,
      justifyContent: 'flex-end',
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xl,
      backgroundColor: theme.colors.bgMain,
    },
    conversation: {
      width: '100%',
      gap: theme.spacing.xl,
    },
    assistantGroup: {
      width: '100%',
      gap: theme.spacing.sm,
    },
    userBubble: {
      width: USER_BUBBLE_WIDTH,
      alignSelf: 'flex-end',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.userBubbleBorder,
      backgroundColor: theme.colors.userBubble,
      ...(theme.isDark ? {} : { boxShadow: '0px 3px 10px rgba(15, 31, 54, 0.08)' }),
    },
    activityCard: {
      width: '100%',
      height: 52,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    lineFull: {
      width: '90%',
    },
    lineLong: {
      width: '76%',
    },
    lineMedium: {
      width: '64%',
    },
    lineShort: {
      width: '48%',
    },
    lineTiny: {
      width: '34%',
    },
    userLineLong: {
      width: '92%',
    },
    userLineShort: {
      width: '68%',
    },
  });
