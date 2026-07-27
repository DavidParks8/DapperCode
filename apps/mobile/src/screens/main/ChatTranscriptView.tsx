import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Text,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
} from 'react-native';

import type { Chat } from '../../api/types';
import { useAppTheme } from '../../theme';
import {
  type AutoScrollState,
  CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX,
  CHAT_JUMP_TO_LATEST_MIN_SCROLLABLE_PX,
  CHAT_MESSAGE_PAGE_SIZE,
  LARGE_CHAT_MESSAGE_COUNT_THRESHOLD,
  findInlineChoiceSet,
  getInitialVisibleMessageStartIndex,
} from './mainScreenHelpers';
import { createStyles } from './mainScreenStyles';
import { buildTranscriptDisplayItems, type TranscriptDisplayItem } from './transcriptMessages';
import { projectTranscript } from './controllers/transcriptProjectionController';
import type { AgUiThreadMessageState } from '../../api/agUiMessages';
import { decorativeAccessibilityProps } from '../../accessibility';
import type { TranscriptContinuationState } from './controllers/transcriptContinuationController';
import { areChatTranscriptViewPropsEqual } from './chatTranscriptComparison';
import { renderChatTranscriptItem } from './chatTranscriptItem';

export interface ChatTranscriptViewProps {
  chat: Chat;
  parentChat: Chat | null;
  bridgeUrl: string;
  bridgeToken: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
  showToolCalls: boolean;
  agentThreadStatusById: ReadonlyMap<string, Chat['status']>;
  scrollRef: React.RefObject<FlatList<TranscriptDisplayItem> | null>;
  inlineChoicesEnabled: boolean;
  onInlineOptionSelect: (value: string) => void;
  onPinnedAutoScroll: (animated?: boolean) => void;
  onJumpToLatest: () => void;
  onScrollInteractionStart: () => void;
  autoScrollStateRef: React.MutableRefObject<AutoScrollState>;
  bottomInset: number;
  liveMessageState?: AgUiThreadMessageState | null;
  onOpenSubAgentThread?: (threadId: string) => void;
  continuationState?: TranscriptContinuationState;
  onLoadEarlier?: () => void;
}

export const ChatTranscriptView = memo(function ChatTranscriptView({
  chat,
  parentChat,
  bridgeUrl,
  bridgeToken,
  onOpenLocalPreview,
  showToolCalls,
  agentThreadStatusById,
  scrollRef,
  inlineChoicesEnabled,
  onInlineOptionSelect,
  onPinnedAutoScroll,
  onJumpToLatest,
  onScrollInteractionStart,
  autoScrollStateRef,
  bottomInset,
  liveMessageState = null,
  onOpenSubAgentThread,
  continuationState,
  onLoadEarlier,
}: ChatTranscriptViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const showJumpToLatestRef = useRef(false);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const scrollOffsetYRef = useRef(0);
  const previousScrollOffsetYRef = useRef(0);
  const scrollingTowardOlderMessagesRef = useRef(false);
  const autoLoadOlderCheckpointRef = useRef<number | null>(null);
  const visibleMessageCountRef = useRef(0);

  const transcriptView = useMemo(
    () =>
      projectTranscript({
        chat,
        parentChat,
        showToolCalls,
        threadStatuses: agentThreadStatusById,
        liveMessageState,
      }),
    [agentThreadStatusById, chat, liveMessageState, parentChat, showToolCalls],
  );
  const visibleMessages = transcriptView.messages;
  const [visibleStartIndex, setVisibleStartIndex] = useState(() =>
    getInitialVisibleMessageStartIndex(visibleMessages.length),
  );
  const paginatedMessages = useMemo(
    () => visibleMessages.slice(visibleStartIndex),
    [visibleMessages, visibleStartIndex],
  );
  const paginatedTranscriptItems = useMemo(
    () => buildTranscriptDisplayItems(paginatedMessages),
    [paginatedMessages],
  );
  const displayMessages = useMemo(
    () => [...paginatedTranscriptItems].reverse(),
    [paginatedTranscriptItems],
  );
  const inlineChoiceSet = useMemo(
    () => (inlineChoicesEnabled ? findInlineChoiceSet(paginatedMessages) : null),
    [inlineChoicesEnabled, paginatedMessages],
  );
  useEffect(() => {
    visibleMessageCountRef.current = visibleMessages.length;
  }, [visibleMessages.length]);

  useEffect(() => {
    setVisibleStartIndex(getInitialVisibleMessageStartIndex(visibleMessageCountRef.current));
  }, [chat.id, showToolCalls]);

  useEffect(() => {
    setVisibleStartIndex((current) => {
      const maxStartIndex = getInitialVisibleMessageStartIndex(visibleMessages.length);
      return current > maxStartIndex ? maxStartIndex : current;
    });
  }, [visibleMessages.length]);

  const loadOlderMessages = useCallback(() => {
    setVisibleStartIndex((current) => Math.max(0, current - CHAT_MESSAGE_PAGE_SIZE));
  }, []);

  const maybeAutoLoadOlderMessages = useCallback(
    (allowShortContentLoad = false) => {
      if (visibleStartIndex <= 0) {
        if (!continuationState?.loading && !continuationState?.exhausted) {
          onLoadEarlier?.();
        }
        return;
      }

      const viewportHeight = viewportHeightRef.current;
      if (viewportHeight <= 0) {
        return;
      }

      const maxOffsetY = Math.max(contentHeightRef.current - viewportHeight, 0);
      const distanceFromOlderEdge = Math.max(0, maxOffsetY - scrollOffsetYRef.current);
      const contentNeedsMoreToScroll = maxOffsetY <= CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX;
      const reachedOlderEdge = distanceFromOlderEdge <= CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX;
      if (!contentNeedsMoreToScroll && !reachedOlderEdge) {
        return;
      }

      if (
        !scrollingTowardOlderMessagesRef.current &&
        !(allowShortContentLoad && contentNeedsMoreToScroll)
      ) {
        return;
      }

      if (autoLoadOlderCheckpointRef.current === visibleStartIndex) {
        return;
      }

      autoLoadOlderCheckpointRef.current = visibleStartIndex;
      loadOlderMessages();
    },
    [
      continuationState?.exhausted,
      continuationState?.loading,
      loadOlderMessages,
      onLoadEarlier,
      visibleStartIndex,
    ],
  );

  const historyBoundary = useMemo(() => {
    if (!continuationState) return null;
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
    if (continuationState.unavailableCount > 0) {
      return (
        <Text style={styles.inlineChoiceHint} accessibilityRole="alert">
          {`${String(continuationState.unavailableCount)} older history ${continuationState.unavailableCount === 1 ? 'entry is' : 'entries are'} no longer available.`}
        </Text>
      );
    }
    return null;
  }, [continuationState, onLoadEarlier, styles.inlineChoiceHint]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const nextOffsetY = Math.max(contentOffset.y, 0);
      contentHeightRef.current = contentSize.height;
      viewportHeightRef.current = layoutMeasurement.height;
      scrollOffsetYRef.current = nextOffsetY;
      scrollingTowardOlderMessagesRef.current = nextOffsetY > previousScrollOffsetYRef.current + 1;
      previousScrollOffsetYRef.current = nextOffsetY;

      const distanceFromBottom = contentOffset.y;
      const shouldStickToBottom = distanceFromBottom <= theme.spacing.xl * 2;
      autoScrollStateRef.current.shouldStickToBottom = shouldStickToBottom;
      const hasScrollableHistory =
        contentSize.height - layoutMeasurement.height > CHAT_JUMP_TO_LATEST_MIN_SCROLLABLE_PX;
      const nextShowJumpToLatest = hasScrollableHistory && !shouldStickToBottom;
      if (showJumpToLatestRef.current !== nextShowJumpToLatest) {
        showJumpToLatestRef.current = nextShowJumpToLatest;
        setShowJumpToLatest(nextShowJumpToLatest);
      }
      maybeAutoLoadOlderMessages(false);
    },
    [autoScrollStateRef, maybeAutoLoadOlderMessages, theme.spacing.xl],
  );

  const hideJumpToLatestWhenContentFits = useCallback(() => {
    if (!showJumpToLatestRef.current) {
      return;
    }
    const viewportHeight = viewportHeightRef.current;
    if (viewportHeight <= 0) {
      return;
    }
    if (contentHeightRef.current - viewportHeight > CHAT_JUMP_TO_LATEST_MIN_SCROLLABLE_PX) {
      return;
    }
    showJumpToLatestRef.current = false;
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    autoScrollStateRef.current.shouldStickToBottom = true;
    autoScrollStateRef.current.isUserInteracting = false;
    autoScrollStateRef.current.isMomentumScrolling = false;
    showJumpToLatestRef.current = false;
    setShowJumpToLatest(false);
    contentHeightRef.current = 0;
    viewportHeightRef.current = 0;
    scrollOffsetYRef.current = 0;
    previousScrollOffsetYRef.current = 0;
    scrollingTowardOlderMessagesRef.current = false;
    autoLoadOlderCheckpointRef.current = null;
  }, [autoScrollStateRef, chat.id]);
  const messageListContentStyle = useMemo(
    () =>
      Platform.OS === 'android'
        ? [styles.messageListContent, { paddingTop: bottomInset }]
        : [styles.messageListContent, { paddingBottom: bottomInset }],
    [bottomInset, styles.messageListContent],
  );
  const isLargeChat = visibleMessages.length >= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD;
  const keyExtractor = useCallback(
    (item: TranscriptDisplayItem) => (item.kind === 'message' ? item.renderKey : item.id),
    [],
  );
  const renderMessageItem = useCallback<ListRenderItem<TranscriptDisplayItem>>(
    ({ item }) =>
      renderChatTranscriptItem({
        item,
        styles,
        bridgeUrl,
        bridgeToken,
        inlineChoiceSet,
        onInlineOptionSelect,
        onOpenLocalPreview,
        onOpenSubAgentThread,
      }),
    [
      bridgeToken,
      bridgeUrl,
      chat.status,
      inlineChoiceSet,
      onInlineOptionSelect,
      onOpenLocalPreview,
      onOpenSubAgentThread,
    ],
  );

  return (
    <View style={styles.messageListShell}>
      <FlatList
        key={chat.id}
        ref={scrollRef}
        data={displayMessages}
        extraData={chat.status}
        keyExtractor={keyExtractor}
        renderItem={renderMessageItem}
        ListFooterComponent={historyBoundary}
        style={styles.messageList}
        contentContainerStyle={messageListContentStyle}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        inverted
        showsVerticalScrollIndicator={false}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          onScrollInteractionStart();
          Keyboard.dismiss();
          autoScrollStateRef.current.isUserInteracting = true;
          autoScrollStateRef.current.isMomentumScrolling = false;
          autoScrollStateRef.current.shouldStickToBottom = false;
        }}
        onScrollEndDrag={() => {
          if (!autoScrollStateRef.current.isMomentumScrolling) {
            autoScrollStateRef.current.isUserInteracting = false;
          }
        }}
        onMomentumScrollBegin={() => {
          autoScrollStateRef.current.isMomentumScrolling = true;
        }}
        onMomentumScrollEnd={() => {
          autoScrollStateRef.current.isUserInteracting = false;
          autoScrollStateRef.current.isMomentumScrolling = false;
        }}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onLayout={(event) => {
          viewportHeightRef.current = event.nativeEvent.layout.height;
          hideJumpToLatestWhenContentFits();
          maybeAutoLoadOlderMessages(true);
        }}
        onContentSizeChange={(_width, height) => {
          contentHeightRef.current = height;
          hideJumpToLatestWhenContentFits();
          onPinnedAutoScroll(false);
          maybeAutoLoadOlderMessages(true);
        }}
        initialNumToRender={Math.min(displayMessages.length, isLargeChat ? 18 : 16)}
        maxToRenderPerBatch={Math.min(displayMessages.length, isLargeChat ? 12 : 10)}
        updateCellsBatchingPeriod={isLargeChat ? 32 : undefined}
        windowSize={isLargeChat ? 13 : 11}
        removeClippedSubviews={false}
        accessibilityLabel={`${chat.title || 'Chat'} transcript`}
      />
      {showJumpToLatest ? (
        <Pressable
          onPress={() => {
            autoScrollStateRef.current.shouldStickToBottom = true;
            autoScrollStateRef.current.isUserInteracting = false;
            autoScrollStateRef.current.isMomentumScrolling = false;
            showJumpToLatestRef.current = false;
            setShowJumpToLatest(false);
            onJumpToLatest();
          }}
          style={({ pressed }) => [
            styles.jumpToLatestButton,
            { bottom: bottomInset + theme.spacing.xs },
            pressed && styles.jumpToLatestButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Jump to latest message"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="arrow-down"
            size={14}
            color={theme.colors.textPrimary}
          />
        </Pressable>
      ) : null}
    </View>
  );
}, areChatTranscriptViewPropsEqual);
