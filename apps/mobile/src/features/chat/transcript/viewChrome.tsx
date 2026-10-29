import { Ionicons } from '@expo/vector-icons';
import {
  useMemo,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { Pressable, Text, View, type FlatList, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { ReduceMotion, ZoomIn, ZoomOut, type SharedValue } from 'react-native-reanimated';

import { ChatScrollRail } from './scrollRail/ChatScrollRail';
import {
  createChatScrollRailJumpController,
  type ChatScrollRailJumpController,
} from './scrollRail/jumpController';
import {
  CHAT_SCROLL_RAIL_CONTENT_CLEARANCE,
  CHAT_SCROLL_RAIL_REVEAL_MARGIN,
  type collectUserMessageAnchors,
} from './scrollRail/geometry';
import { useAppTheme } from '@shared/theme';
import { useSceneContentInsets } from '@shell/layout/useShellLayout';
import { LARGE_CHAT_MESSAGE_COUNT_THRESHOLD, type AutoScrollState } from '../helpers/helpers';
import type { createStyles } from '../styles/styles';
import type { TranscriptDisplayItem } from './messages';
import type { TranscriptContinuationState } from './controllers/continuationController';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import type { computeHitSlop } from '@shared/ui/touchTarget';
import { motion } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import type { Chat } from '@bridge/types/types';
import { TranscriptActivitySlot, type useCollapsibleActivity } from './TranscriptActivitySlot';

export const JUMP_TO_LATEST_VISIBLE_SIZE = { width: 48, height: 48 };

export function TranscriptHistoryEdge() {
  return <View collapsable={false} />;
}

// Keep spacing inside measured cells: a container gap makes virtual spacers underestimate lengths.
export function TranscriptItemSeparator() {
  const theme = useAppTheme();
  return <View style={{ height: theme.spacing.xl }} />;
}

export const resolveResetRailActiveIndex = (count: number) => Math.max(-1, count - 1);
export const resolveRailRestingActiveIndex = (activeIndex: number, count: number) =>
  activeIndex >= 0 ? activeIndex : resolveResetRailActiveIndex(count);
export const resolveListBatchingConfig = (count: number, messageCount: number) => {
  const isLarge = messageCount >= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD;
  return {
    initialNumToRender: Math.min(count, isLarge ? 18 : 16),
    maxToRenderPerBatch: Math.min(count, isLarge ? 12 : 10),
    updateCellsBatchingPeriod: isLarge ? 32 : undefined,
    windowSize: isLarge ? 13 : 11,
  };
};
export function renderHistoryRecovery(
  chat: Chat,
  presentation: ReturnType<typeof useCollapsibleActivity>,
  animationActive: boolean,
  onRetry: (() => void) | undefined,
  styles: ReturnType<typeof createStyles>,
): ReactElement | null {
  const activity = presentation ? (
    <TranscriptActivitySlot
      chat={chat}
      presentation={presentation}
      animationActive={animationActive}
    />
  ) : null;
  if (!chat.historyRecoveryError) {
    return activity;
  }
  return (
    <>
      {activity}
      <Pressable
        testID="chat-history-recovery"
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Fast forwarding"
        accessibilityHint="Chat history is catching up automatically. Double tap to retry now."
        style={{ minHeight: 48, justifyContent: 'center' }}
      >
        <Text style={styles.inlineChoiceHint}>Fast forwarding...</Text>
      </Pressable>
    </>
  );
}
export function renderHistoryBoundary(params: {
  continuationState?: TranscriptContinuationState;
  onLoadEarlier?: () => void;
  styles: ReturnType<typeof createStyles>;
}): ReactElement | null {
  const { continuationState, onLoadEarlier, styles } = params;
  if (!continuationState) {
    return null;
  }
  if (continuationState.loading) {
    return <Text style={styles.inlineChoiceHint}>Loading earlier history...</Text>;
  }
  if (continuationState.error) {
    return (
      <Pressable
        onPress={onLoadEarlier}
        accessibilityRole="button"
        accessibilityLabel="Retry loading earlier history"
      >
        <Text style={styles.inlineChoiceHint}>Earlier history failed to load. Tap to retry.</Text>
      </Pressable>
    );
  }
  if (!continuationState.exhausted) {
    return (
      <Pressable
        onPress={onLoadEarlier}
        accessibilityRole="button"
        accessibilityLabel="Load earlier messages"
      >
        <Text style={styles.inlineChoiceHint}>Load earlier</Text>
      </Pressable>
    );
  }
  if (continuationState.unavailableCount === 0) {
    return null;
  }
  return (
    <Text style={styles.inlineChoiceHint} accessibilityRole="alert">
      {`${String(continuationState.unavailableCount)} older history ${continuationState.unavailableCount === 1 ? 'entry is' : 'entries are'} no longer available.`}
    </Text>
  );
}
export function ensureRailJumpController(params: {
  railJumpControllerRef: RefObject<ChatScrollRailJumpController | null>;
  displayIndexByMessageIdRef: RefObject<Map<string, number>>;
  scrollRefRef: RefObject<RefObject<FlatList<TranscriptDisplayItem> | null>>;
  setVisibleStartIndex: Dispatch<SetStateAction<number>>;
  spacingLg: number;
  topInsetRef: RefObject<number>;
}) {
  if (params.railJumpControllerRef.current) {
    return;
  }
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
        viewOffset: -(params.spacingLg + params.topInsetRef.current),
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
  topInset: number;
  viewportHeight: number;
  windowStart: number;
  alwaysVisible: boolean;
}): ReactNode {
  if (!params.scrollRailEnabled) {
    return null;
  }
  return (
    <ChatScrollRail
      anchors={params.anchors}
      activeIndex={params.activeIndex}
      windowStart={params.windowStart}
      capacity={params.capacity}
      topInset={params.topInset}
      viewportHeight={params.viewportHeight}
      alwaysVisible={params.alwaysVisible}
      engaged={params.engaged}
      fingerY={params.fingerY}
    />
  );
}
export function renderJumpToLatestButton(params: {
  autoScrollStateRef: RefObject<AutoScrollState>;
  bottomInset: number;
  /** Leading space to skip so the centered button sits on the trailing page, off a hinge. */
  foldLeadingInset: number;
  hitSlop: ReturnType<typeof computeHitSlop>;
  onJumpToLatest: () => void;
  railJumpControllerRef: RefObject<ChatScrollRailJumpController | null>;
  setShowJumpToLatest: Dispatch<SetStateAction<boolean>>;
  showJumpToLatest: boolean;
  showJumpToLatestRef: RefObject<boolean>;
  styles: ReturnType<typeof createStyles>;
  theme: ReturnType<typeof useAppTheme>;
}): ReactNode {
  if (!params.showJumpToLatest) {
    return null;
  }
  return (
    <Animated.View
      entering={ZoomIn.duration(motion.duration.routine).reduceMotion(ReduceMotion.System)}
      exiting={ZoomOut.duration(motion.duration.immediate).reduceMotion(ReduceMotion.System)}
      style={[
        params.styles.jumpToLatestButton,
        {
          bottom: params.bottomInset + params.theme.spacing.xs,
          marginLeft: params.foldLeadingInset,
        },
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
        <GlassSurface
          pointerEvents="none"
          role="capsule"
          style={params.styles.jumpToLatestGlass}
          testID="jump-to-latest-glass-surface"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="arrow-down"
            size={18}
            color={params.theme.colors.textPrimary}
          />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Inverted padding: bottom clears the top chrome plus a gutter; top clears the composer. The sides
 * keep messages in a readable column on wide windows, clear of the rail pinned there.
 */
export function useTranscriptContentLayout(
  baseStyle: StyleProp<ViewStyle>,
  insets: { top: number; bottom: number },
  gutter: number,
  railPinnable: boolean,
): { messageListContentStyle: StyleProp<ViewStyle>; foldLeadingInset: number } {
  const { readable, foldLeading } = useSceneContentInsets();
  const horizontal = Math.max(
    gutter + readable,
    railPinnable ? CHAT_SCROLL_RAIL_CONTENT_CLEARANCE : 0,
  );
  const messageListContentStyle = useMemo(
    () => [
      baseStyle,
      {
        paddingTop: insets.bottom,
        paddingBottom: insets.top + gutter,
        paddingHorizontal: horizontal,
      },
    ],
    [baseStyle, gutter, horizontal, insets.bottom, insets.top],
  );
  return { messageListContentStyle, foldLeadingInset: foldLeading };
}
