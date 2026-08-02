import { Ionicons } from '@expo/vector-icons';
import type { Dispatch, MutableRefObject, ReactNode, RefObject, SetStateAction } from 'react';
import { Pressable, type FlatList } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion, type SharedValue } from 'react-native-reanimated';

import { TABLET_LAYOUT_MIN_WIDTH } from '../../bootstrap/appConstants';
import { ChatScrollRail } from '../../components/chatScrollRail/ChatScrollRail';
import {
  createChatScrollRailJumpController,
  type ChatScrollRailJumpController,
} from '../../components/chatScrollRail/chatScrollRailJumpController';
import {
  CHAT_SCROLL_RAIL_REVEAL_MARGIN,
  type collectUserMessageAnchors,
} from '../../components/chatScrollRail/chatScrollRailGeometry';
import type { useAppTheme } from '../../theme';
import type { AutoScrollState } from './mainScreenHelpers';
import type { createStyles } from './mainScreenStyles';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { decorativeAccessibilityProps } from '../../accessibility';
import type { computeHitSlop } from '../../components/touchTarget';
import { motionDuration } from '../../components/motion';

export const JUMP_TO_LATEST_VISIBLE_SIZE = { width: 34, height: 34 };

export const resolveResetRailActiveIndex = (count: number) => Math.max(-1, count - 1);
export const resolveRailRestingActiveIndex = (activeIndex: number, count: number) =>
  activeIndex >= 0 ? activeIndex : resolveResetRailActiveIndex(count);
export const resolveListBatchingConfig = (count: number, isLarge: boolean) => ({
  initialNumToRender: Math.min(count, isLarge ? 18 : 16),
  maxToRenderPerBatch: Math.min(count, isLarge ? 12 : 10),
  updateCellsBatchingPeriod: isLarge ? 32 : undefined,
  windowSize: isLarge ? 13 : 11,
});
export function ensureRailJumpController(params: {
  railJumpControllerRef: MutableRefObject<ChatScrollRailJumpController | null>;
  displayIndexByMessageIdRef: MutableRefObject<Map<string, number>>;
  scrollRefRef: MutableRefObject<RefObject<FlatList<TranscriptDisplayItem> | null>>;
  setVisibleStartIndex: Dispatch<SetStateAction<number>>;
  spacingLg: number;
}) {
  if (params.railJumpControllerRef.current) return;
  params.railJumpControllerRef.current = createChatScrollRailJumpController({
    resolveDisplayIndex: (messageId) =>
      params.displayIndexByMessageIdRef.current.get(messageId) ?? null,
    revealTranscriptIndex: (transcriptIndex) =>
      params.setVisibleStartIndex((current) =>
        Math.min(current, Math.max(0, transcriptIndex - CHAT_SCROLL_RAIL_REVEAL_MARGIN)),
      ),
    scrollToIndex: (index) =>
      params.scrollRefRef.current.current?.scrollToIndex({
        index,
        animated: false,
        viewPosition: 1,
        viewOffset: -params.spacingLg,
      }),
    scrollToOffset: (offset) =>
      params.scrollRefRef.current.current?.scrollToOffset({ offset, animated: false }),
  });
}
export function renderScrollRail(params: {
  activeIndex: number;
  anchors: ReturnType<typeof collectUserMessageAnchors>;
  capacity: number;
  engaged: SharedValue<number>;
  fingerY: SharedValue<number>;
  scrollRailEnabled: boolean;
  viewportHeight: number;
  windowStart: number;
  windowWidth: number;
}): ReactNode {
  if (!params.scrollRailEnabled) return null;
  return (
    <ChatScrollRail
      anchors={params.anchors}
      activeIndex={params.activeIndex}
      windowStart={params.windowStart}
      capacity={params.capacity}
      viewportHeight={params.viewportHeight}
      alwaysVisible={params.windowWidth >= TABLET_LAYOUT_MIN_WIDTH}
      engaged={params.engaged}
      fingerY={params.fingerY}
    />
  );
}
export function renderJumpToLatestButton(params: {
  autoScrollStateRef: MutableRefObject<AutoScrollState>;
  bottomInset: number;
  hitSlop: ReturnType<typeof computeHitSlop>;
  onJumpToLatest: () => void;
  railJumpControllerRef: MutableRefObject<ChatScrollRailJumpController | null>;
  setShowJumpToLatest: Dispatch<SetStateAction<boolean>>;
  showJumpToLatest: boolean;
  showJumpToLatestRef: MutableRefObject<boolean>;
  styles: ReturnType<typeof createStyles>;
  theme: ReturnType<typeof useAppTheme>;
}): ReactNode {
  if (!params.showJumpToLatest) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
      style={[
        params.styles.jumpToLatestButton,
        { bottom: params.bottomInset + params.theme.spacing.xs },
      ]}
    >
      <Pressable
        onPress={() => {
          params.railJumpControllerRef.current?.cancel();
          params.autoScrollStateRef.current.shouldStickToBottom = true;
          params.autoScrollStateRef.current.isUserInteracting = false;
          params.autoScrollStateRef.current.isMomentumScrolling = false;
          params.showJumpToLatestRef.current = false;
          params.setShowJumpToLatest(false);
          params.onJumpToLatest();
        }}
        hitSlop={params.hitSlop}
        style={({ pressed }) => [
          params.styles.jumpToLatestButtonInner,
          pressed && params.styles.jumpToLatestButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Jump to latest message"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="arrow-down"
          size={14}
          color={params.theme.colors.textPrimary}
        />
      </Pressable>
    </Animated.View>
  );
}
