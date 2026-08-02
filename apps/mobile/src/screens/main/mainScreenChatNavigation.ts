import {
  activePlanAtom,
  activeTurnIdAtom,
  creatingAtom,
  errorAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  sendingAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import { agentRootThreadIdAtom, relatedAgentThreadsAtom } from '../../state/mainScreen/workspace';
import {
  activityAtom,
  queueActionItemIdAtom,
  queueActionKindAtom,
} from '../../state/mainScreen/composer';
import { useSetAtom } from 'jotai';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import type { Chat } from '../../api/types';
import { OPENING_CHAT_ACTIVITY_TITLE } from './mainScreenHelpers';
import type {
  MainScreenChatLoadPipelineContext,
  MainScreenChatLoadPipelineResult,
} from './mainScreenChatLoadPipeline';
import { agentThreadMenuVisibleAtom } from '../../state/mainScreen/modals';
import { openSubAgentAtom } from '../../navigation/actions';
import { routes } from '../../navigation/routes';

export type MainScreenChatNavigationContext = MainScreenChatLoadPipelineContext &
  MainScreenChatLoadPipelineResult;

export function useMainScreenChatNavigation(context: MainScreenChatNavigationContext) {
  const router = useRouter();
  const { chatId, profileId } = useLocalSearchParams<{
    chatId?: string;
    profileId?: string;
  }>();
  const {
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
    setOpeningChatId,
    setSelectedChat,
    setSelectedChatId,
    setTranscriptContinuationState,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    transcriptContinuationController,
    transcriptContinuationState,
  } = context;
  // The controller object is rebuilt every render; only its actions are referentially stable.
  const { closePathModal: closeAttachmentPathModal } = attachmentController;
  const setSending = useSetAtom(sendingAtom);
  const setCreating = useSetAtom(creatingAtom);
  const setError = useSetAtom(errorAtom);
  const setPendingUserInputRequest = useSetAtom(pendingUserInputRequestAtom);
  const setUserInputDrafts = useSetAtom(userInputDraftsAtom);
  const setUserInputError = useSetAtom(userInputErrorAtom);
  const setResolvingUserInput = useSetAtom(resolvingUserInputAtom);
  const setActivePlan = useSetAtom(activePlanAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setAgentRootThreadId = useSetAtom(agentRootThreadIdAtom);
  const setRelatedAgentThreads = useSetAtom(relatedAgentThreadsAtom);
  const setQueueActionItemId = useSetAtom(queueActionItemIdAtom);
  const setQueueActionKind = useSetAtom(queueActionKindAtom);
  const setActivity = useSetAtom(activityAtom);
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);
  const openSubAgent = useSetAtom(openSubAgentAtom);

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
    setSelectedChat((previous) => (previous?.id === chat.id ? result.chat : previous));
    api.rememberChat(result.chat);
    setTranscriptContinuationState(result.state);
  }, [
    api,
    loadChat,
    selectedChatIdRef,
    selectedChatRef,
    setSelectedChat,
    setTranscriptContinuationState,
    transcriptContinuationController,
    transcriptContinuationState.loading,
  ]);

  const openChatThread = useCallback(
    (id: string, optimisticChat?: Chat | null) => {
      const isSameChat = chatIdRef.current === id;
      const providedSnapshot = optimisticChat && optimisticChat.id === id ? optimisticChat : null;
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
      // The previous chat's sub-agent tree describes work that has nothing to do with this
      // chat, and the refresh that replaces it is asynchronous. Leaving it in place made a
      // finished chat open as "Working" whenever the chat before it had a live sub-agent.
      setRelatedAgentThreads([]);
      setAgentRootThreadId(null);
      setSending(false);
      setCreating(false);
      setError(null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
      closeAttachmentPathModal();
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
        title: OPENING_CHAT_ACTIVITY_TITLE,
      });

      applyThreadRuntimeSnapshot(id);
      void refreshPendingApprovalsForThread(id);
      loadChat(id, { forceScroll: true, revalidate: hasHydratedSnapshot }).catch(() => {});
    },
    [
      api,
      applyThreadRuntimeSnapshot,
      autoEnabledPlanTurnIdByThreadRef,
      chatIdRef,
      closeAttachmentPathModal,
      loadChat,
      mergeChatWithPendingOptimisticMessages,
      openingChatStartedAtRef,
      refreshPendingApprovalsForThread,
      setActivePlan,
      setActiveTurnId,
      setActivity,
      setAgentRootThreadId,
      setAgentThreadMenuVisible,
      setCreating,
      setError,
      setOpeningChatId,
      setPendingUserInputRequest,
      setQueueActionItemId,
      setQueueActionKind,
      setRelatedAgentThreads,
      setResolvingUserInput,
      setSelectedChat,
      setSelectedChatId,
      setSending,
      setStoppingTurn,
      setUserInputDrafts,
      setUserInputError,
      stopRequestedRef,
      stopSystemMessageLoggedRef,
    ],
  );

  const closeAgentDetail = useCallback(() => {
    if (profileId && chatId) {
      router.dismissTo(routes.chat(profileId, chatId));
    }
  }, [chatId, profileId, router]);

  const openAgentDetail = useCallback(
    (threadId: string) => {
      setAgentThreadMenuVisible(false);
      openSubAgent(threadId);
    },
    [openSubAgent, setAgentThreadMenuVisible],
  );

  return {
    handleLoadEarlier,
    openChatThread,
    closeAgentDetail,
    openAgentDetail,
  };
}

export type MainScreenChatNavigationResult = ReturnType<typeof useMainScreenChatNavigation>;
