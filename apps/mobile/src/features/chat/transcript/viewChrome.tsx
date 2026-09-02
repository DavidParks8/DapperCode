import { Ionicons } from '@expo/vector-icons';
import type { Dispatch, ReactElement, ReactNode, RefObject, SetStateAction } from 'react';
import { Pressable, Text, type FlatList } from 'react-native';
import Animated, { ReduceMotion, ZoomIn, ZoomOut, type SharedValue } from 'react-native-reanimated';

import { TABLET_LAYOUT_MIN_WIDTH } from '@shell/boot/appConstants';
import { ChatScrollRail } from './scrollRail/ChatScrollRail';
import {
  createChatScrollRailJumpController,
  type ChatScrollRailJumpController,
} from './scrollRail/jumpController';
import {
  CHAT_SCROLL_RAIL_REVEAL_MARGIN,
  type collectUserMessageAnchors,
} from './scrollRail/geometry';
import type { useAppTheme } from '@shared/theme';
import type { AutoScrollState } from '../helpers/helpers';
import type { createStyles } from '../styles/styles';
import type { TranscriptDisplayItem } from './messages';
import type { TranscriptContinuationState } from './controllers/continuationController';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import type { computeHitSlop } from '@shared/ui/touchTarget';
import { motion } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';

export const JUMP_TO_LATEST_VISIBLE_SIZE = { width: 48, height: 48 };

export const resolveResetRailActiveIndex = (count: number) => Math.max(-1, count - 1);
export const resolveRailRestingActiveIndex = (activeIndex: number, count: number) =>
  activeIndex >= 0 ? activeIndex : resolveResetRailActiveIndex(count);
export const resolveListBatchingConfig = (count: number, isLarge: boolean) => ({
  initialNumToRender: Math.min(count, isLarge ? 18 : 16),
  maxToRenderPerBatch: Math.min(count, isLarge ? 12 : 10),
  updateCellsBatchingPeriod: isLarge ? 32 : undefined,
  windowSize: isLarge ? 13 : 11,
});
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
  windowWidth: number;
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
      alwaysVisible={params.windowWidth >= TABLET_LAYOUT_MIN_WIDTH}
      engaged={params.engaged}
      fingerY={params.fingerY}
    />
  );
}
export function renderJumpToLatestButton(params: {
  autoScrollStateRef: RefObject<AutoScrollState>;
  bottomInset: number;
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
