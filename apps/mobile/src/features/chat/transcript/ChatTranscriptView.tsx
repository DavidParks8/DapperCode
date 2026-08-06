import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
  useWindowDimensions,
  View,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';

import type { Chat } from '@bridge/types/types';
import type { ChatScrollRailJumpController } from './scrollRail/jumpController';
import {
  collectUserMessageAnchors,
  railWindowCapacity,
  resolveActiveAnchorIndex,
} from './scrollRail/geometry';
import { useChatScrollRail } from './scrollRail/useChatScrollRail';
import { useAppTheme } from '@shared/theme';
import {
  type ActivityState,
  type AutoScrollState,
  CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX,
  CHAT_JUMP_TO_LATEST_MIN_SCROLLABLE_PX,
  CHAT_MESSAGE_PAGE_SIZE,
  LARGE_CHAT_MESSAGE_COUNT_THRESHOLD,
  findInlineChoiceSet,
  getInitialVisibleMessageStartIndex,
} from '../helpers/helpers';
import { createStyles } from '../styles/styles';
import {
  buildTranscriptDisplayItems,
  transcriptDisplayItemKey,
  type TranscriptDisplayItem,
} from './messages';
import { projectTranscript } from './controllers/projectionController';
import type { AgUiThreadMessageState } from '@bridge/agui/agUiMessages';
import type { TranscriptContinuationState } from './controllers/continuationController';
import { areChatTranscriptViewPropsEqual } from './comparison';
import { renderChatTranscriptItem } from './item';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { useForkBoundaries, useForkConversationAction } from './useForkConversationAction';
import { ActivityEvent } from './ActivityEvent';
import { TranscriptEdgeScrim } from './TranscriptEdgeScrim';
import {
  ensureRailJumpController,
  JUMP_TO_LATEST_VISIBLE_SIZE,
  renderHistoryBoundary,
  renderJumpToLatestButton,
  renderScrollRail,
  resolveListBatchingConfig,
  resolveRailRestingActiveIndex,
  resolveResetRailActiveIndex,
} from './viewChrome';
import { useActivityElapsedMs } from './activityDuration';
import { useMessageTimestampReveal } from './useMessageTimestampReveal';

export interface ChatTranscriptViewProps {
  chat: Chat;
  parentChat: Chat | null;
  bridgeUrl: string;
  bridgeToken: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
  showToolCalls: boolean;
  agentThreadStatusById: ReadonlyMap<string, Chat['status']>;
  scrollRef: RefObject<FlatList<TranscriptDisplayItem> | null>;
  inlineChoicesEnabled: boolean;
  onInlineOptionSelect: (value: string) => void;
  onPinnedAutoScroll: (animated?: boolean) => void;
  onJumpToLatest: () => void;
  onScrollInteractionStart: () => void;
  autoScrollStateRef: RefObject<AutoScrollState>;
  bottomInset: number;
  topInset?: number;
  liveMessageState?: AgUiThreadMessageState | null;
  onOpenSubAgentThread?: (threadId: string) => void;
  continuationState?: TranscriptContinuationState;
  onLoadEarlier?: () => void;
  scrollRailEnabled?: boolean;
  supportsConversationFork?: boolean;
  supportsForkFromResponse?: boolean;
  onForkConversation?: (messageId: string) => Promise<unknown>;
  activity?: ActivityState | null;
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
  topInset = 0,
  liveMessageState = null,
  onOpenSubAgentThread,
  continuationState,
  onLoadEarlier,
  scrollRailEnabled = true,
  supportsConversationFork = false,
  supportsForkFromResponse = false,
  onForkConversation,
  activity = null,
}: ChatTranscriptViewProps) {
  const theme = useAppTheme();
  const { width: windowWidth } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [restingRailActiveIndex, setRestingRailActiveIndex] = useState(-1);
  const { forkingMessageId, handleForkConversation } =
    useForkConversationAction(onForkConversation);
  const showJumpToLatestRef = useRef(false);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const scrollOffsetYRef = useRef(0);
  const previousScrollOffsetYRef = useRef(0);
  const scrollingTowardOlderMessagesRef = useRef(false);
  const autoLoadOlderCheckpointRef = useRef<number | null>(null);
  const visibleMessageCountRef = useRef(0);
  const userMessageAnchorCountRef = useRef(0);
  const displayIndexByMessageIdRef = useRef(new Map<string, number>());
  const anchorDisplayIndicesRef = useRef<readonly (number | null)[]>([]);
  const topInsetRef = useRef(topInset);
  const scrollRefRef = useRef(scrollRef);
  const railJumpControllerRef = useRef<ChatScrollRailJumpController | null>(null);

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
  const userMessageAnchors = useMemo(
    () => collectUserMessageAnchors(visibleMessages),
    [visibleMessages],
  );
  const displayIndexByMessageId = useMemo(() => {
    const next = new Map<string, number>();
    displayMessages.forEach((item, index) => {
      if (item.kind === 'message') {
        next.set(item.message.id, index);
      }
    });
    return next;
  }, [displayMessages]);
  displayIndexByMessageIdRef.current = displayIndexByMessageId;
  scrollRefRef.current = scrollRef;
  topInsetRef.current = topInset;
  anchorDisplayIndicesRef.current = userMessageAnchors.map(
    (anchor) => displayIndexByMessageId.get(anchor.messageId) ?? null,
  );
  const inlineChoiceSet = useMemo(
    () => (inlineChoicesEnabled ? findInlineChoiceSet(paginatedMessages) : null),
    [inlineChoicesEnabled, paginatedMessages],
  );
  const forkBoundaries = useForkBoundaries({
    messages: visibleMessages,
    chatStatus: chat.status,
    parentThreadId: chat.parentThreadId,
    unavailableCount: continuationState?.unavailableCount,
    supportsConversationFork,
    supportsForkFromResponse,
  });
  const userMessageAnchorCount = userMessageAnchors.length;
  useEffect(() => {
    visibleMessageCountRef.current = visibleMessages.length;
    userMessageAnchorCountRef.current = userMessageAnchorCount;
  }, [userMessageAnchorCount, visibleMessages.length]);

  ensureRailJumpController({
    railJumpControllerRef,
    displayIndexByMessageIdRef,
    scrollRefRef,
    setVisibleStartIndex,
    spacingLg: theme.spacing.lg,
    topInsetRef,
  });

  useEffect(() => {
    railJumpControllerRef.current?.notifyDataChanged();
  }, [displayMessages]);

  useEffect(
    () => () => {
      railJumpControllerRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    setVisibleStartIndex(getInitialVisibleMessageStartIndex(visibleMessageCountRef.current));
    setRestingRailActiveIndex(resolveResetRailActiveIndex(userMessageAnchorCountRef.current));
    railJumpControllerRef.current?.cancel();
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

  const historyBoundary = useMemo(
    () => renderHistoryBoundary({ continuationState, onLoadEarlier, styles }),
    [continuationState, onLoadEarlier, styles],
  );

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

  const onViewableItemsChanged = useRef(
    ({
      viewableItems,
    }: {
      viewableItems: Array<ViewToken<TranscriptDisplayItem>>;
      changed: Array<ViewToken<TranscriptDisplayItem>>;
    }) => {
      const visualTopDisplayIndex = viewableItems.reduce(
        (top, token) => (typeof token.index === 'number' ? Math.max(top, token.index) : top),
        -1,
      );
      if (visualTopDisplayIndex < 0) {
        return;
      }
      const nextActiveIndex = resolveActiveAnchorIndex(
        anchorDisplayIndicesRef.current,
        visualTopDisplayIndex,
      );
      if (nextActiveIndex >= 0) {
        setRestingRailActiveIndex((current) =>
          current === nextActiveIndex ? current : nextActiveIndex,
        );
      }
    },
  ).current;
  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 1 }).current;
  const railViewportHeight = Math.max(0, viewportHeight - topInset);
  const railCapacity = railWindowCapacity(railViewportHeight);
  const handleRailInteractionStart = useCallback(() => {
    onScrollInteractionStart();
    autoScrollStateRef.current.isUserInteracting = true;
    autoScrollStateRef.current.isMomentumScrolling = false;
    autoScrollStateRef.current.shouldStickToBottom = false;
  }, [autoScrollStateRef, onScrollInteractionStart]);
  const handleRailInteractionEnd = useCallback(() => {
    autoScrollStateRef.current.isUserInteracting = false;
  }, [autoScrollStateRef]);
  const handleRailJump = useCallback((anchor: (typeof userMessageAnchors)[number]) => {
    railJumpControllerRef.current?.request(anchor);
  }, []);
  const handleRailReachStart = useCallback(() => {
    if (!continuationState?.loading && !continuationState?.exhausted) {
      onLoadEarlier?.();
    }
  }, [continuationState?.exhausted, continuationState?.loading, onLoadEarlier]);
  const rail = useChatScrollRail({
    enabled: scrollRailEnabled,
    resetKey: chat.id,
    anchors: userMessageAnchors,
    capacity: railCapacity,
    viewportHeight: railViewportHeight,
    topInset,
    restingActiveIndex: resolveRailRestingActiveIndex(
      restingRailActiveIndex,
      userMessageAnchorCount,
    ),
    onJumpToAnchor: handleRailJump,
    onInteractionStart: handleRailInteractionStart,
    onInteractionEnd: handleRailInteractionEnd,
    onReachStart: handleRailReachStart,
  });
  const timestampReveal = useMessageTimestampReveal(rail.gesture);

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
      // The list is inverted, so its content padding is flipped on screen: `paddingBottom` lands
      // under the floating top chrome and `paddingTop` lands behind the composer. Feeding these
      // the other way round left the oldest message permanently clipped by the header. The extra
      // gutter keeps the oldest message from stopping flush against the chrome.
      [
        styles.messageListContent,
        { paddingTop: bottomInset, paddingBottom: topInset + theme.spacing.lg },
      ],
    [bottomInset, styles.messageListContent, theme.spacing.lg, topInset],
  );
  const jumpToLatestHitSlop = useMemo(() => computeHitSlop(JUMP_TO_LATEST_VISIBLE_SIZE), []);
  const isLargeChat = visibleMessages.length >= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD;
  const listBatchingConfig = useMemo(
    () => resolveListBatchingConfig(displayMessages.length, isLargeChat),
    [displayMessages.length, isLargeChat],
  );
  const threadRunning = chat.status === 'running';
  const activityElapsedMs = useActivityElapsedMs(chat, activity);
  const listExtraData = useMemo(
    () => ({ liveMessageState, chatStatus: chat.status }),
    [chat.status, liveMessageState],
  );
  const activityEvent = activity ? (
    <ActivityEvent {...activity} elapsedMs={activityElapsedMs} />
  ) : null;
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
        forkBoundaryMessageId:
          item.kind === 'message' && onForkConversation
            ? forkBoundaries.get(item.message.id)
            : undefined,
        forkBusy:
          item.kind === 'message' && forkBoundaries.get(item.message.id) === forkingMessageId,
        onForkConversation: handleForkConversation,
        timestampRevealTranslationX: timestampReveal.translationX,
        threadRunning,
      }),
    [
      bridgeToken,
      bridgeUrl,
      forkBoundaries,
      forkingMessageId,
      handleForkConversation,
      inlineChoiceSet,
      onInlineOptionSelect,
      onOpenLocalPreview,
      onOpenSubAgentThread,
      onForkConversation,
      styles,
      timestampReveal.translationX,
      threadRunning,
    ],
  );

  return (
    <GestureDetector gesture={timestampReveal.gesture}>
      <View style={styles.messageListShell}>
        <FlatList
          key={chat.id}
          ref={scrollRef}
          data={displayMessages}
          extraData={listExtraData}
          keyExtractor={transcriptDisplayItemKey}
          renderItem={renderMessageItem}
          ListHeaderComponent={activityEvent}
          ListFooterComponent={historyBoundary}
          style={styles.messageList}
          contentContainerStyle={messageListContentStyle}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          inverted
          scrollEnabled={rail.scrollEnabled}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => {
            railJumpControllerRef.current?.cancel();
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
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onScrollToIndexFailed={(info) => {
            railJumpControllerRef.current?.handleScrollToIndexFailed(info);
          }}
          onLayout={(event) => {
            const nextViewportHeight = event.nativeEvent.layout.height;
            viewportHeightRef.current = nextViewportHeight;
            setViewportHeight((current) =>
              current === nextViewportHeight ? current : nextViewportHeight,
            );
            railJumpControllerRef.current?.notifyLayoutProgress();
            hideJumpToLatestWhenContentFits();
            maybeAutoLoadOlderMessages(true);
          }}
          onContentSizeChange={(_width, height) => {
            contentHeightRef.current = height;
            railJumpControllerRef.current?.notifyLayoutProgress();
            hideJumpToLatestWhenContentFits();
            onPinnedAutoScroll(false);
            maybeAutoLoadOlderMessages(true);
          }}
          initialNumToRender={listBatchingConfig.initialNumToRender}
          maxToRenderPerBatch={listBatchingConfig.maxToRenderPerBatch}
          updateCellsBatchingPeriod={listBatchingConfig.updateCellsBatchingPeriod}
          windowSize={listBatchingConfig.windowSize}
          removeClippedSubviews={false}
          accessibilityLabel={`${chat.title || 'Chat'} transcript`}
        />
        <TranscriptEdgeScrim bottomInset={bottomInset} edgeStyle={styles.transcriptEdgeScrim} />
        {renderScrollRail({
          activeIndex: rail.state.activeIndex,
          anchors: userMessageAnchors,
          capacity: railCapacity,
          engaged: rail.engaged,
          fingerY: rail.fingerY,
          scrollRailEnabled,
          topInset,
          viewportHeight: railViewportHeight,
          windowStart: rail.state.windowStart,
          windowWidth,
        })}
        {renderJumpToLatestButton({
          autoScrollStateRef,
          bottomInset,
          hitSlop: jumpToLatestHitSlop,
          onJumpToLatest,
          railJumpControllerRef,
          setShowJumpToLatest,
          showJumpToLatest,
          showJumpToLatestRef,
          styles,
          theme,
        })}
      </View>
    </GestureDetector>
  );
}, areChatTranscriptViewPropsEqual);
