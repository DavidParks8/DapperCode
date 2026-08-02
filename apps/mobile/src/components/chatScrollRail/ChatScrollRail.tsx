import { memo, useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useAppTheme } from '../../theme';
import {
  CHAT_SCROLL_RAIL_BAR_HEIGHT,
  CHAT_SCROLL_RAIL_BAR_PITCH,
  CHAT_SCROLL_RAIL_COLLAPSED_ACTIVE_WIDTH,
  CHAT_SCROLL_RAIL_COLLAPSED_WIDTH,
  CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH,
  barCenterY,
  fisheyeBarWidth,
  railRenderRange,
  railTopInset,
  type UserMessageAnchor,
} from './chatScrollRailGeometry';
import { createChatScrollRailStyles } from './chatScrollRailStyles';

const RAIL_ENGAGE_DURATION_MS = 180;
const RAIL_RELEASE_DURATION_MS = 130;
const RAIL_SLOT_DURATION_MS = 140;
const RAIL_HIGHLIGHT_DURATION_MS = 110;
const RAIL_EASING = Easing.bezier(0.16, 1, 0.3, 1);

export interface ChatScrollRailProps {
  anchors: readonly UserMessageAnchor[];
  activeIndex: number;
  windowStart: number;
  capacity: number;
  viewportHeight: number;
  alwaysVisible: boolean;
  engaged: SharedValue<number>;
  fingerY: SharedValue<number>;
}

interface RailBarProps {
  messageId: string;
  slot: number;
  railTop: number;
  active: boolean;
  engaged: SharedValue<number>;
  fingerY: SharedValue<number>;
}

const RailBar = memo(function RailBar({
  messageId,
  slot,
  railTop,
  active,
  engaged,
  fingerY,
}: RailBarProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createChatScrollRailStyles(theme), [theme]);
  const reduceMotion = useReducedMotion();
  const animatedSlot = useSharedValue(slot);
  const activeProgress = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    animatedSlot.value = reduceMotion
      ? slot
      : withTiming(slot, { duration: RAIL_SLOT_DURATION_MS, easing: RAIL_EASING });
  }, [animatedSlot, reduceMotion, slot]);

  useEffect(() => {
    activeProgress.value = reduceMotion
      ? active
        ? 1
        : 0
      : withTiming(active ? 1 : 0, {
          duration: RAIL_HIGHLIGHT_DURATION_MS,
          easing: RAIL_EASING,
        });
  }, [active, activeProgress, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => {
    const collapsedWidth =
      CHAT_SCROLL_RAIL_COLLAPSED_WIDTH +
      (CHAT_SCROLL_RAIL_COLLAPSED_ACTIVE_WIDTH - CHAT_SCROLL_RAIL_COLLAPSED_WIDTH) *
        activeProgress.value;
    const distance = fingerY.value - barCenterY(animatedSlot.value, railTop);
    const engagedWidth = fisheyeBarWidth(distance);
    const width = collapsedWidth + (engagedWidth - collapsedWidth) * engaged.value;
    const proximity =
      (engagedWidth - CHAT_SCROLL_RAIL_COLLAPSED_WIDTH) /
      (CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH - CHAT_SCROLL_RAIL_COLLAPSED_WIDTH);
    const emphasis = Math.max(activeProgress.value, proximity * engaged.value);

    return {
      width,
      opacity: 0.46 + emphasis * 0.5,
      backgroundColor: interpolateColor(
        emphasis,
        [0, 1],
        [theme.colors.textMuted, theme.colors.textPrimary],
      ),
      transform: [
        {
          translateY: animatedSlot.value * CHAT_SCROLL_RAIL_BAR_PITCH,
        },
      ],
    };
  });

  return (
    <Animated.View
      testID={`chat-scroll-rail-bar-${messageId}`}
      style={[styles.bar, animatedStyle]}
    />
  );
});

export const ChatScrollRail = memo(function ChatScrollRail({
  anchors,
  activeIndex,
  windowStart,
  capacity,
  viewportHeight,
  alwaysVisible,
  engaged,
  fingerY,
}: ChatScrollRailProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createChatScrollRailStyles(theme), [theme]);
  const reduceMotion = useReducedMotion();
  const visibility = useSharedValue(alwaysVisible ? 1 : 0);
  const top = railTopInset(viewportHeight, anchors.length, capacity);
  const visibleCount = Math.min(anchors.length, capacity);
  const clipHeight =
    visibleCount <= 0
      ? 0
      : (visibleCount - 1) * CHAT_SCROLL_RAIL_BAR_PITCH + CHAT_SCROLL_RAIL_BAR_HEIGHT;
  const renderRange = railRenderRange(windowStart, anchors.length, capacity);
  const renderedAnchors = anchors.slice(renderRange.start, renderRange.end);

  useEffect(() => {
    if (alwaysVisible) {
      visibility.value = reduceMotion
        ? 1
        : withTiming(1, { duration: RAIL_ENGAGE_DURATION_MS, easing: RAIL_EASING });
      return;
    }
    visibility.value = engaged.value;
  }, [alwaysVisible, engaged, reduceMotion, visibility]);

  const rootStyle = useAnimatedStyle(() => ({
    opacity: alwaysVisible ? 1 : visibility.value || engaged.value,
  }));

  if (anchors.length === 0 || viewportHeight <= 0) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="chat-scroll-rail"
      style={[styles.root, rootStyle]}
    >
      <View style={[styles.clip, { top, height: clipHeight }]}>
        {renderedAnchors.map((anchor, renderedIndex) => {
          const anchorIndex = renderRange.start + renderedIndex;
          return (
            <RailBar
              key={anchor.messageId}
              messageId={anchor.messageId}
              slot={anchorIndex - windowStart}
              railTop={top}
              active={anchorIndex === activeIndex}
              engaged={engaged}
              fingerY={fingerY}
            />
          );
        })}
      </View>
    </Animated.View>
  );
});

export function animateRailEngagement(
  engaged: SharedValue<number>,
  value: 0 | 1,
  reduceMotion: boolean,
): void {
  engaged.value = reduceMotion
    ? value
    : withTiming(value, {
        duration: value === 1 ? RAIL_ENGAGE_DURATION_MS : RAIL_RELEASE_DURATION_MS,
        easing: RAIL_EASING,
      });
}
