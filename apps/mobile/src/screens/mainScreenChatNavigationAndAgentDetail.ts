import {
  activityAtom,
  queueActionItemIdAtom,
  queueActionKindAtom
} from '../state/mainScreen/composer';
import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type { Chat } from '../api/types';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { MainScreenChatLoadPipelineContext, MainScreenChatLoadPipelineResult } from './mainScreenChatLoadPipeline';
import {
  agentThreadMenuVisibleAtom
} from '../state/mainScreen/modals';






export type MainScreenChatNavigationAndAgentDetailContext = MainScreenChatLoadPipelineContext & MainScreenChatLoadPipelineResult;

export function useMainScreenChatNavigationAndAgentDetail(context: MainScreenChatNavigationAndAgentDetailContext) {
  const {
    agentDetailRequestRef,
    agentDetailStack,
    agentRootThreadId,
    agentThreadsController,
    api,
    applyThreadRuntimeSnapshot,
    attachmentController,
    autoEnabledPlanTurnIdByThreadRef,
    chatIdRef,
    loadChat,
    mergeChatWithPendingOptimisticMessages,
    openingChatStartedAtRef,
    refreshPendingApprovalsForThread,
    selectedChatIdRef,
    selectedChatRef,
    setActivePlan,
    setActiveTurnId,
    setAgentDetailChat,
    setAgentDetailError,
    setAgentDetailLoading,
    setAgentDetailParentChat,
    setAgentDetailStack,
    setAgentDetailThreadId,
    setCreating,
    setError,
    setOpeningChatId,
    setPendingUserInputRequest,
    setResolvingUserInput,
    setSelectedChat,
    setSelectedChatId,
    setSending,
    setStoppingTurn,
    setTranscriptContinuationState,
    setUserInputDrafts,
    setUserInputError,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    transcriptContinuationController,
    transcriptContinuationState,
  } = context;
  const setQueueActionItemId = useSetAtom(queueActionItemIdAtom);
  const setQueueActionKind = useSetAtom(queueActionKindAtom);
  const setActivity = useSetAtom(activityAtom);
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);


  const handleLoadEarlier = useCallback(async () => {
    const chat = selectedChatRef.current;
    if (!chat || transcriptContinuationState.loading) return;
    setTranscriptContinuationState((previous) => ({ ...previous, loading: true, error: null }));
    const result = await transcriptContinuationController.loadEarlier(chat);
    if (selectedChatIdRef.current !== chat.id) return;
    if (result.kind === 'stale') {
      setTranscriptContinuationState(result.state);
      void loadChat(chat.id, { preserveRuntimeState: true });
      return;
    }
    setSelectedChat((previous) => previous?.id === chat.id ? result.chat : previous);
    api.rememberChat(result.chat);
    setTranscriptContinuationState(result.state);
  }, [api, loadChat, transcriptContinuationController, transcriptContinuationState.loading]);

  const openChatThread = useCallback(
    (id: string, optimisticChat?: Chat | null) => {
      const isSameChat = chatIdRef.current === id;
      const providedSnapshot =
        optimisticChat && optimisticChat.id === id ? optimisticChat : null;
      const providedHydratedSnapshot =
        providedSnapshot && providedSnapshot.messages.length > 0 ? providedSnapshot : null;
      const cachedChat = providedHydratedSnapshot ?? api.peekChat(id);
      const optimisticSnapshot = cachedChat ?? providedSnapshot ?? api.peekChatShell(id);
      const hasHydratedSnapshot = Boolean(cachedChat);

      if (isSameChat) {
        setSelectedChatId(id);
        openingChatStartedAtRef.current = 0;
        setOpeningChatId(null);
        setError(null);
        if (optimisticSnapshot) {
          setSelectedChat(mergeChatWithPendingOptimisticMessages(optimisticSnapshot));
        }
        void refreshPendingApprovalsForThread(id);
        loadChat(id, {
          forceScroll: true,
          preserveRuntimeState: true,
          revalidate: hasHydratedSnapshot,
        }).catch(() => {});
        return;
      }

      setSelectedChatId(id);
      openingChatStartedAtRef.current = hasHydratedSnapshot ? 0 : Date.now();
      setOpeningChatId(hasHydratedSnapshot ? null : id);
      setSending(false);
      setCreating(false);
      setError(null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
    attachmentController.closePathModal();
      setAgentThreadMenuVisible(false);
      setActivePlan(null);
      setActiveTurnId(null);
      setStoppingTurn(false);
      setQueueActionItemId(null);
      setQueueActionKind(null);
      stopRequestedRef.current = false;
      stopSystemMessageLoggedRef.current = false;
      delete autoEnabledPlanTurnIdByThreadRef.current[id];

      if (optimisticSnapshot) {
        setSelectedChat(mergeChatWithPendingOptimisticMessages(optimisticSnapshot));
      } else {
        setSelectedChat(null);
      }
      setActivity({
        tone: 'running',
        title: 'Opening chat',
      });

      applyThreadRuntimeSnapshot(id);
      void refreshPendingApprovalsForThread(id);
      loadChat(id, { forceScroll: true, revalidate: hasHydratedSnapshot }).catch(() => {});
    },
    [
      api,
      applyThreadRuntimeSnapshot,
      loadChat,
      mergeChatWithPendingOptimisticMessages,
      refreshPendingApprovalsForThread,
    ]
  );

  const closeAgentDetail = useCallback(() => {
    agentDetailRequestRef.current += 1;
    setAgentDetailStack([]);
    setAgentDetailThreadId(null);
    setAgentDetailChat(null);
    setAgentDetailParentChat(null);
    setAgentDetailLoading(false);
    setAgentDetailError(null);
  }, []);

  const loadAgentDetail = useCallback(
    async (threadId: string, showLoading = false) => {
      const requestId = agentDetailRequestRef.current + 1;
      agentDetailRequestRef.current = requestId;
      if (showLoading) {
        setAgentDetailLoading(true);
      }

      try {
        const { chat, parent } = await agentThreadsController.loadDetail(threadId);
        if (agentDetailRequestRef.current !== requestId) {
          return;
        }
        setAgentDetailChat((previous) =>
          previous?.id === chat.id ? resolveEquivalentChat(previous, chat) : chat
        );
        setAgentDetailParentChat(parent);
        setAgentDetailError(null);
      } catch (err) {
        if (agentDetailRequestRef.current === requestId) {
          setAgentDetailError((err as Error).message);
        }
      } finally {
        if (agentDetailRequestRef.current === requestId) {
          setAgentDetailLoading(false);
        }
      }
    },
    [agentThreadsController]
  );

  const showAgentDetail = useCallback(
    (threadId: string) => {
      setAgentThreadMenuVisible(false);
      setAgentDetailThreadId(threadId);
      setAgentDetailChat(api.peekChat(threadId) ?? api.peekChatShell(threadId));
      setAgentDetailParentChat(null);
      setAgentDetailError(null);
      void loadAgentDetail(threadId, true);
    },
    [api, loadAgentDetail, setAgentDetailChat, setAgentDetailError, setAgentDetailParentChat, setAgentDetailThreadId, setAgentThreadMenuVisible]
  );

  const openAgentDetail = useCallback(
    (threadId: string) => {
      if (!threadId || threadId === agentRootThreadId) {
        closeAgentDetail();
        return;
      }
      // A sub-agent can itself spawn sub-agents, so drilling in has to stack:
      // Back walks one level up rather than dumping you to the main thread.
      setAgentDetailStack((previous) =>
        previous[previous.length - 1] === threadId
          ? previous
          : [...previous.filter((id) => id !== threadId), threadId]
      );
      showAgentDetail(threadId);
    },
    [agentRootThreadId, closeAgentDetail, setAgentDetailStack, showAgentDetail]
  );

  const popAgentDetail = useCallback(() => {
    const parent = agentDetailStack[agentDetailStack.length - 2];
    if (!parent) {
      closeAgentDetail();
      return;
    }
    setAgentDetailStack((previous) => previous.slice(0, -1));
    showAgentDetail(parent);
  }, [agentDetailStack, closeAgentDetail, setAgentDetailStack, showAgentDetail]);

  return {
    handleLoadEarlier,
    openChatThread,
    closeAgentDetail,
    popAgentDetail,
    loadAgentDetail,
    openAgentDetail,
  };
}

export type MainScreenChatNavigationAndAgentDetailResult = ReturnType<typeof useMainScreenChatNavigationAndAgentDetail>;
