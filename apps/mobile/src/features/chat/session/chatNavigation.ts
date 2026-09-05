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
} from '../state/turn';
import { agentRootThreadIdAtom, relatedAgentThreadsAtom } from '../../workspace/state/workspace';
import { activityAtom, queueActionItemIdAtom, queueActionKindAtom } from '../state/composer';
import { useSetAtom } from 'jotai';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import type { Chat } from '@bridge/types/types';
import { OPENING_CHAT_ACTIVITY_TITLE } from '../helpers/helpers';
import type {
  MainScreenChatLoadPipelineContext,
  MainScreenChatLoadPipelineResult,
} from './loadPipeline';
import { agentThreadMenuVisibleAtom } from '../state/modals';
import { openSubAgentAtom } from '@shell/navigation/actions';
import { navigateRoot } from '@shell/navigation/routeNavigation';
import { routes } from '@shell/navigation/routes';
import {
  getTranscriptBeforeCursor,
  getTranscriptContinuationState,
  mergeTranscriptPage,
} from '../transcript/controllers/continuationController';

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
  const historyRequestRef = useRef<object | null>(null);
  const selectedChatId = selectedChatIdRef.current;
  useEffect(
    () => () => {
      historyRequestRef.current = null;
    },
    [api, selectedChatId],
  );

  const handleLoadEarlier = useCallback(async () => {
    const chat = selectedChatRef.current;
    if (!chat || selectedChatIdRef.current !== chat.id || historyRequestRef.current) {
      return;
    }
    const request = {};
    historyRequestRef.current = request;
    setTranscriptContinuationState((previous) => ({ ...previous, loading: true, error: null }));
    const result = await transcriptContinuationController.loadEarlier(chat);
    if (historyRequestRef.current !== request) {
      return;
    }
    historyRequestRef.current = null;
    if (selectedChatIdRef.current !== chat.id) {
      return;
    }
    setSelectedChat((previous) => {
      if (!previous || previous.id !== chat.id) {
        return previous;
      }
      const currentState = getTranscriptContinuationState(previous);
      if (
        previous.acpSnapshot?.continuation?.revision !== chat.acpSnapshot?.continuation?.revision ||
        getTranscriptBeforeCursor(previous.acpSnapshot) !==
          getTranscriptBeforeCursor(chat.acpSnapshot)
      ) {
        setTranscriptContinuationState(currentState);
        return previous;
      }
      if (result.kind === 'stale') {
        setTranscriptContinuationState(currentState);
        void loadChat(chat.id, { preserveRuntimeState: true });
        return previous;
      }
      if (result.kind !== 'page') {
        setTranscriptContinuationState({
          ...currentState,
          error: result.kind === 'error' ? result.error : null,
        });
        return previous;
      }
      const merged = mergeTranscriptPage(previous, result.page);
      api.rememberChat(merged);
      setTranscriptContinuationState(getTranscriptContinuationState(merged));
      return merged;
    });
  }, [
    api,
    loadChat,
    selectedChatIdRef,
    selectedChatRef,
    setSelectedChat,
    setTranscriptContinuationState,
    transcriptContinuationController,
  ]);

  const openChatThread = useCallback(
    (id: string, optimisticChat?: Chat | null) => {
      historyRequestRef.current = null;
      const isSameChat = chatIdRef.current === id;
      const providedSnapshot = optimisticChat && optimisticChat.id === id ? optimisticChat : null;
      const providedHydratedSnapshot =
        providedSnapshot && providedSnapshot.messages.length > 0 ? providedSnapshot : null;
      const cachedChat = providedHydratedSnapshot ?? api.peekChat(id);
      const optimisticSnapshot = cachedChat ?? providedSnapshot ?? api.peekChatShell(id);
      const hasHydratedSnapshot = Boolean(cachedChat);
      setTranscriptContinuationState(
        optimisticSnapshot
          ? getTranscriptContinuationState(optimisticSnapshot)
          : { loading: false, error: null, exhausted: true, unavailableCount: 0 },
      );

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
      setTranscriptContinuationState,
      setUserInputDrafts,
      setUserInputError,
      stopRequestedRef,
      stopSystemMessageLoggedRef,
    ],
  );

  const forkConversation = useCallback(
    async (messageId: string) => {
      const source = selectedChatRef.current;
      if (!source) {
        throw new Error('Open a conversation before forking it.');
      }
      setError(null);
      setActivity({ tone: 'running', title: 'Forking conversation' });
      try {
        const forked = await api.forkChat(source.id, messageId);
        api.rememberChat(forked);
        openChatThread(forked.id, forked);
        if (profileId) {
          // Pushing would stack a second chat screen whose route still names the source chat.
          // Both screens stay mounted and drive the shared selected-chat state, so they reopen
          // each other's thread in a loop that strobes the transcript until the app dies.
          navigateRoot(routes.chat(profileId, forked.id));
        }
        return forked;
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        setError(message);
        setActivity({
          tone: 'error',
          title: 'Could not fork conversation',
          detail: message,
        });
        throw error;
      }
    },
    [api, openChatThread, profileId, selectedChatRef, setActivity, setError],
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
    forkConversation,
    closeAgentDetail,
    openAgentDetail,
  };
}

export type MainScreenChatNavigationResult = ReturnType<typeof useMainScreenChatNavigation>;
