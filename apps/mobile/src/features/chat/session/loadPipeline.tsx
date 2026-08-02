import { activeTurnIdAtom, errorAtom, pendingApprovalAtom, stoppingTurnAtom } from '../state/turn';
import { activityAtom } from '../state/composer';
import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type { Chat } from '@bridge/types/types';
import {
  sleep,
  RUN_WATCHDOG_MS,
  type ActivityState,
  shouldSurfaceChatLoadError,
  isChatLikelyRunning,
  resolveSettledActivity,
  retireOpeningChatActivity,
} from '../helpers/helpers';
import { getTranscriptContinuationState } from '../transcript/controllers/continuationController';
import { resolveEquivalentChat } from '../state/chatState';
import type {
  MainScreenSlashCommandHandlerContext,
  MainScreenSlashCommandHandlerResult,
} from '../composer/slashCommandHandler';
import { OPEN_CHAT_MIN_LOADING_MS } from '../screen/constants';
import { shouldReleaseOpeningChat, shouldScrollAfterLoad } from './openingChatState';

export type MainScreenChatLoadPipelineContext = MainScreenSlashCommandHandlerContext &
  MainScreenSlashCommandHandlerResult;

type LoadChatOptions = {
  forceScroll?: boolean;
  preserveRuntimeState?: boolean;
  revalidate?: boolean;
};

type SetActivity = (update: ActivityState | ((current: ActivityState) => ActivityState)) => void;

function isCurrentLoadRequest(
  loadChatRequestRef: MainScreenChatLoadPipelineContext['loadChatRequestRef'],
  requestId: number,
): boolean {
  return requestId === loadChatRequestRef.current;
}

function queueThreadQueueRead(params: {
  requestId: number;
  chatId: string;
  loadChatRequestRef: MainScreenChatLoadPipelineContext['loadChatRequestRef'];
  chatSyncController: MainScreenChatLoadPipelineContext['chatSyncController'];
  cacheThreadQueueState: MainScreenChatLoadPipelineContext['cacheThreadQueueState'];
}): void {
  const { requestId, chatId, loadChatRequestRef, chatSyncController, cacheThreadQueueState } =
    params;
  void chatSyncController
    .readQueue(chatId)
    .then((queueState) => {
      if (isCurrentLoadRequest(loadChatRequestRef, requestId)) {
        cacheThreadQueueState(chatId, queueState);
      }
    })
    .catch(() => {});
}

function shouldPreserveRuntimeStateForLoad(
  options: LoadChatOptions | undefined,
  chatId: string,
  currentChatId: string | null,
): boolean {
  return Boolean(options?.preserveRuntimeState && chatId === currentChatId);
}

function setLoadedChatSelection(params: {
  chatId: string;
  chat: Chat;
  autoEnabledPlanTurnIdByThreadRef: MainScreenChatLoadPipelineContext['autoEnabledPlanTurnIdByThreadRef'];
  shouldPreserveRuntimeState: boolean;
  setSelectedChatId: MainScreenChatLoadPipelineContext['setSelectedChatId'];
  setSelectedChat: MainScreenChatLoadPipelineContext['setSelectedChat'];
  setTranscriptContinuationState: MainScreenChatLoadPipelineContext['setTranscriptContinuationState'];
  setError: (value: string | null) => void;
}): void {
  const {
    chatId,
    chat,
    autoEnabledPlanTurnIdByThreadRef,
    shouldPreserveRuntimeState,
    setSelectedChatId,
    setSelectedChat,
    setTranscriptContinuationState,
    setError,
  } = params;
  if (!shouldPreserveRuntimeState) {
    delete autoEnabledPlanTurnIdByThreadRef.current[chatId];
  }

  setSelectedChatId(chatId);
  setSelectedChat((prev) =>
    prev && prev.id === chat.id ? resolveEquivalentChat(prev, chat) : chat,
  );
  setTranscriptContinuationState(getTranscriptContinuationState(chat));
  setError(null);
}

function setLoadedRunningChatState(params: {
  chatId: string;
  chat: Chat;
  threadRuntimeSnapshotsRef: MainScreenChatLoadPipelineContext['threadRuntimeSnapshotsRef'];
  cacheThreadTurnState: MainScreenChatLoadPipelineContext['cacheThreadTurnState'];
  setActivity: SetActivity;
}): void {
  const { chatId, chat, threadRuntimeSnapshotsRef, cacheThreadTurnState, setActivity } = params;
  const restoredActiveTurnId =
    chat.activeTurnId?.trim() ||
    threadRuntimeSnapshotsRef.current[chatId]?.activeTurnId?.trim() ||
    null;

  cacheThreadTurnState(chatId, {
    activeTurnId: restoredActiveTurnId,
    runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
  });
  setActivity({
    tone: 'running',
    title: 'Working',
  });
}

function setLoadedSettledChatState(params: {
  chatId: string;
  chat: Chat;
  clearRunWatchdog: MainScreenChatLoadPipelineContext['clearRunWatchdog'];
  cacheThreadTurnState: MainScreenChatLoadPipelineContext['cacheThreadTurnState'];
  setActivity: SetActivity;
}): void {
  const { chatId, chat, clearRunWatchdog, cacheThreadTurnState, setActivity } = params;
  clearRunWatchdog();
  cacheThreadTurnState(chatId, {
    activeTurnId: null,
    runWatchdogUntil: 0,
  });
  setActivity(resolveSettledActivity(chat));
}

function resetLoadedChatRuntimeState(params: {
  chatId: string;
  chat: Chat;
  setActiveCommands: MainScreenChatLoadPipelineContext['setActiveCommands'];
  setPendingApproval: (value: null) => void;
  setStreamingText: MainScreenChatLoadPipelineContext['setStreamingText'];
  setActiveTurnId: (value: string | null) => void;
  setStoppingTurn: (value: boolean) => void;
  stopSystemMessageLoggedRef: MainScreenChatLoadPipelineContext['stopSystemMessageLoggedRef'];
  cacheThreadTurnState: MainScreenChatLoadPipelineContext['cacheThreadTurnState'];
  threadRuntimeSnapshotsRef: MainScreenChatLoadPipelineContext['threadRuntimeSnapshotsRef'];
  clearRunWatchdog: MainScreenChatLoadPipelineContext['clearRunWatchdog'];
  setActivity: SetActivity;
  reasoningSummaryRef: MainScreenChatLoadPipelineContext['reasoningSummaryRef'];
  reasoningBufferRef: MainScreenChatLoadPipelineContext['reasoningBufferRef'];
  hadCommandRef: MainScreenChatLoadPipelineContext['hadCommandRef'];
  applyThreadRuntimeSnapshot: MainScreenChatLoadPipelineContext['applyThreadRuntimeSnapshot'];
}): void {
  const {
    chatId,
    chat,
    setActiveCommands,
    setPendingApproval,
    setStreamingText,
    setActiveTurnId,
    setStoppingTurn,
    stopSystemMessageLoggedRef,
    cacheThreadTurnState,
    threadRuntimeSnapshotsRef,
    clearRunWatchdog,
    setActivity,
    reasoningSummaryRef,
    reasoningBufferRef,
    hadCommandRef,
    applyThreadRuntimeSnapshot,
  } = params;
  setActiveCommands([]);
  setPendingApproval(null);
  setStreamingText(null);
  setActiveTurnId(null);
  setStoppingTurn(false);
  stopSystemMessageLoggedRef.current = false;
  if (isChatLikelyRunning(chat)) {
    setLoadedRunningChatState({
      chatId,
      chat,
      threadRuntimeSnapshotsRef,
      cacheThreadTurnState,
      setActivity,
    });
  } else {
    setLoadedSettledChatState({
      chatId,
      chat,
      clearRunWatchdog,
      cacheThreadTurnState,
      setActivity,
    });
  }
  reasoningSummaryRef.current = {};
  reasoningBufferRef.current = '';
  hadCommandRef.current = false;
  applyThreadRuntimeSnapshot(chatId);
}

function applyLoadedChat(params: {
  chatId: string;
  chat: Chat;
  options: LoadChatOptions | undefined;
  autoEnabledPlanTurnIdByThreadRef: MainScreenChatLoadPipelineContext['autoEnabledPlanTurnIdByThreadRef'];
  chatIdRef: MainScreenChatLoadPipelineContext['chatIdRef'];
  setSelectedChatId: MainScreenChatLoadPipelineContext['setSelectedChatId'];
  setSelectedChat: MainScreenChatLoadPipelineContext['setSelectedChat'];
  setTranscriptContinuationState: MainScreenChatLoadPipelineContext['setTranscriptContinuationState'];
  setActiveCommands: MainScreenChatLoadPipelineContext['setActiveCommands'];
  setStreamingText: MainScreenChatLoadPipelineContext['setStreamingText'];
  stopSystemMessageLoggedRef: MainScreenChatLoadPipelineContext['stopSystemMessageLoggedRef'];
  cacheThreadTurnState: MainScreenChatLoadPipelineContext['cacheThreadTurnState'];
  threadRuntimeSnapshotsRef: MainScreenChatLoadPipelineContext['threadRuntimeSnapshotsRef'];
  clearRunWatchdog: MainScreenChatLoadPipelineContext['clearRunWatchdog'];
  reasoningSummaryRef: MainScreenChatLoadPipelineContext['reasoningSummaryRef'];
  reasoningBufferRef: MainScreenChatLoadPipelineContext['reasoningBufferRef'];
  hadCommandRef: MainScreenChatLoadPipelineContext['hadCommandRef'];
  applyThreadRuntimeSnapshot: MainScreenChatLoadPipelineContext['applyThreadRuntimeSnapshot'];
  refreshPendingApprovalsForThread: MainScreenChatLoadPipelineContext['refreshPendingApprovalsForThread'];
  setError: (value: string | null) => void;
  setPendingApproval: (value: null) => void;
  setActiveTurnId: (value: string | null) => void;
  setStoppingTurn: (value: boolean) => void;
  setActivity: SetActivity;
}): void {
  const {
    chatId,
    chat,
    options,
    autoEnabledPlanTurnIdByThreadRef,
    chatIdRef,
    setSelectedChatId,
    setSelectedChat,
    setTranscriptContinuationState,
    setActiveCommands,
    setStreamingText,
    stopSystemMessageLoggedRef,
    cacheThreadTurnState,
    threadRuntimeSnapshotsRef,
    clearRunWatchdog,
    reasoningSummaryRef,
    reasoningBufferRef,
    hadCommandRef,
    applyThreadRuntimeSnapshot,
    refreshPendingApprovalsForThread,
    setError,
    setPendingApproval,
    setActiveTurnId,
    setStoppingTurn,
    setActivity,
  } = params;
  const shouldPreserveRuntimeState = shouldPreserveRuntimeStateForLoad(
    options,
    chatId,
    chatIdRef.current,
  );

  setLoadedChatSelection({
    chatId,
    chat,
    autoEnabledPlanTurnIdByThreadRef,
    shouldPreserveRuntimeState,
    setSelectedChatId,
    setSelectedChat,
    setTranscriptContinuationState,
    setError,
  });

  if (shouldPreserveRuntimeState) {
    setActivity((current) => retireOpeningChatActivity(current, chat));
  } else {
    resetLoadedChatRuntimeState({
      chatId,
      chat,
      setActiveCommands,
      setPendingApproval,
      setStreamingText,
      setActiveTurnId,
      setStoppingTurn,
      stopSystemMessageLoggedRef,
      cacheThreadTurnState,
      threadRuntimeSnapshotsRef,
      clearRunWatchdog,
      setActivity,
      reasoningSummaryRef,
      reasoningBufferRef,
      hadCommandRef,
      applyThreadRuntimeSnapshot,
    });
  }

  void refreshPendingApprovalsForThread(chatId);
}

function handleChatLoadError(params: {
  error: unknown;
  requestId: number;
  loadChatRequestRef: MainScreenChatLoadPipelineContext['loadChatRequestRef'];
  options: LoadChatOptions | undefined;
  selectedChatRef: MainScreenChatLoadPipelineContext['selectedChatRef'];
  chatId: string;
  setError: (value: string) => void;
  setActivity: SetActivity;
}): boolean {
  const {
    error,
    requestId,
    loadChatRequestRef,
    options,
    selectedChatRef,
    chatId,
    setError,
    setActivity,
  } = params;
  if (!isCurrentLoadRequest(loadChatRequestRef, requestId)) {
    return false;
  }

  const cachedChat = selectedChatRef.current;
  if (
    !shouldSurfaceChatLoadError(
      options?.revalidate,
      cachedChat?.id,
      chatId,
      cachedChat?.messages.length ?? 0,
    )
  ) {
    return false;
  }

  const message = (error as Error).message;
  setError(message);
  setActivity({
    tone: 'error',
    title: 'Failed to load chat',
    detail: message,
  });
  return false;
}

async function finalizeChatLoad(params: {
  loadedSuccessfully: boolean;
  requestId: number;
  loadChatRequestRef: MainScreenChatLoadPipelineContext['loadChatRequestRef'];
  options: LoadChatOptions | undefined;
  scrollToBottomReliable: MainScreenChatLoadPipelineContext['scrollToBottomReliable'];
  scrollToBottomIfPinned: MainScreenChatLoadPipelineContext['scrollToBottomIfPinned'];
  openingChatStartedAtRef: MainScreenChatLoadPipelineContext['openingChatStartedAtRef'];
  setOpeningChatId: MainScreenChatLoadPipelineContext['setOpeningChatId'];
  chatId: string;
}): Promise<boolean> {
  const {
    loadedSuccessfully,
    requestId,
    loadChatRequestRef,
    options,
    scrollToBottomReliable,
    scrollToBottomIfPinned,
    openingChatStartedAtRef,
    setOpeningChatId,
    chatId,
  } = params;
  const superseded = !isCurrentLoadRequest(loadChatRequestRef, requestId);

  if (shouldScrollAfterLoad({ loadedSuccessfully, superseded })) {
    if (options?.forceScroll) {
      scrollToBottomReliable(false);
    } else {
      scrollToBottomIfPinned(false);
    }
  }

  if (!shouldReleaseOpeningChat({ loadedSuccessfully, superseded })) {
    return loadedSuccessfully;
  }

  const startedAt = openingChatStartedAtRef.current;
  if (loadedSuccessfully && startedAt > 0) {
    const remainingMs = OPEN_CHAT_MIN_LOADING_MS - (Date.now() - startedAt);
    if (remainingMs > 0) {
      await sleep(remainingMs);
    }
  }

  setOpeningChatId((current) => {
    if (current === chatId) {
      openingChatStartedAtRef.current = 0;
      return null;
    }
    return current;
  });
  return loadedSuccessfully;
}

export function useMainScreenChatLoadPipeline(context: MainScreenChatLoadPipelineContext) {
  const {
    applyThreadRuntimeSnapshot,
    autoEnabledPlanTurnIdByThreadRef,
    cacheThreadQueueState,
    cacheThreadTurnState,
    chatIdRef,
    chatSyncController,
    clearRunWatchdog,
    hadCommandRef,
    loadChatRequestRef,
    mergeChatWithPendingOptimisticMessages,
    openingChatStartedAtRef,
    reasoningBufferRef,
    reasoningSummaryRef,
    refreshPendingApprovalsForThread,
    scrollToBottomIfPinned,
    scrollToBottomReliable,
    selectedChatRef,
    setActiveCommands,
    setOpeningChatId,
    setSelectedChat,
    setSelectedChatId,
    setStreamingText,
    setTranscriptContinuationState,
    stopSystemMessageLoggedRef,
    threadRuntimeSnapshotsRef,
  } = context;
  const setError = useSetAtom(errorAtom);
  const setPendingApproval = useSetAtom(pendingApprovalAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setActivity = useSetAtom(activityAtom);

  const loadChat = useCallback(
    async (chatId: string, options?: LoadChatOptions): Promise<boolean> => {
      const requestId = loadChatRequestRef.current + 1;
      loadChatRequestRef.current = requestId;
      let loadedSuccessfully = false;
      try {
        queueThreadQueueRead({
          requestId,
          chatId,
          loadChatRequestRef,
          chatSyncController,
          cacheThreadQueueState,
        });
        const loadedChat = await chatSyncController.load(chatId);
        const chat = mergeChatWithPendingOptimisticMessages(loadedChat);
        if (!isCurrentLoadRequest(loadChatRequestRef, requestId)) {
          setActivity((current) => retireOpeningChatActivity(current, chat));
        } else {
          loadedSuccessfully = true;
          applyLoadedChat({
            chatId,
            chat,
            options,
            autoEnabledPlanTurnIdByThreadRef,
            chatIdRef,
            setSelectedChatId,
            setSelectedChat,
            setTranscriptContinuationState,
            setActiveCommands,
            setStreamingText,
            stopSystemMessageLoggedRef,
            cacheThreadTurnState,
            threadRuntimeSnapshotsRef,
            clearRunWatchdog,
            reasoningSummaryRef,
            reasoningBufferRef,
            hadCommandRef,
            applyThreadRuntimeSnapshot,
            refreshPendingApprovalsForThread,
            setError,
            setPendingApproval,
            setActiveTurnId,
            setStoppingTurn,
            setActivity,
          });
        }
      } catch (err) {
        handleChatLoadError({
          error: err,
          requestId,
          loadChatRequestRef,
          options,
          selectedChatRef,
          chatId,
          setError,
          setActivity,
        });
      }
      return finalizeChatLoad({
        loadedSuccessfully,
        requestId,
        loadChatRequestRef,
        options,
        scrollToBottomReliable,
        scrollToBottomIfPinned,
        openingChatStartedAtRef,
        setOpeningChatId,
        chatId,
      });
    },
    [
      chatSyncController,
      applyThreadRuntimeSnapshot,
      autoEnabledPlanTurnIdByThreadRef,
      cacheThreadQueueState,
      cacheThreadTurnState,
      chatIdRef,
      clearRunWatchdog,
      hadCommandRef,
      loadChatRequestRef,
      mergeChatWithPendingOptimisticMessages,
      openingChatStartedAtRef,
      reasoningBufferRef,
      reasoningSummaryRef,
      refreshPendingApprovalsForThread,
      scrollToBottomIfPinned,
      scrollToBottomReliable,
      selectedChatRef,
      setActiveCommands,
      setActiveTurnId,
      setActivity,
      setError,
      setOpeningChatId,
      setPendingApproval,
      setSelectedChat,
      setSelectedChatId,
      setStoppingTurn,
      setStreamingText,
      setTranscriptContinuationState,
      stopSystemMessageLoggedRef,
      threadRuntimeSnapshotsRef,
    ],
  );

  return {
    loadChat,
  };
}

export type MainScreenChatLoadPipelineResult = ReturnType<typeof useMainScreenChatLoadPipeline>;
