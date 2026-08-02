import { selectedCollaborationModeAtom } from '../state/models';
import {
  pendingPlanImplementationPromptsAtom,
  planPanelCollapsedByThreadAtom,
} from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import {
  PLAN_IMPLEMENTATION_CODING_MESSAGE,
  shouldAutoEnablePlanModeFromChat,
} from '../helpers/helpers';
import type {
  MainScreenComposerRendererContext,
  MainScreenComposerRendererResult,
} from '../composer/renderer';

export type MainScreenPlanExecutionActionsContext = MainScreenComposerRendererContext &
  MainScreenComposerRendererResult;

export function useMainScreenPlanExecutionActions(context: MainScreenPlanExecutionActionsContext) {
  const {
    autoEnabledPlanTurnIdByThreadRef,
    clearPendingPlanImplementationPrompt,
    dismissedPlanImplementationTurnIdByThreadRef,
    isOpeningChat,
    planPanelLastTurnByThreadRef,
    scrollToBottomIfPinned,
    selectedChat,
    selectedChatId,
    selectedPlanImplementationPrompt,
    selectedThreadPlan,
    sendMessageContent,
    showActivity,
    supportsPlanMode,
  } = context;
  const selectedCollaborationMode = useAtomValue(selectedCollaborationModeAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const pendingPlanImplementationPrompts = useAtomValue(pendingPlanImplementationPromptsAtom);
  const setPlanPanelCollapsedByThread = useSetAtom(planPanelCollapsedByThreadAtom);
  const setPendingPlanImplementationPrompts = useSetAtom(pendingPlanImplementationPromptsAtom);

  // Derived during render so the auto-enable effect keeps depending on the decision itself rather
  // than on the chat object, which is rebuilt on every transcript update.
  const selectedThreadId = selectedChat?.id ?? null;
  const latestPlanTurnId = selectedChat?.latestTurnPlan?.turnId?.trim() ?? '';
  const hasLatestTurnPlan = Boolean(selectedChat?.latestTurnPlan);
  // Agents that cannot run a plan turn still publish plan/to-do updates, so
  // never flip the composer into plan mode on their behalf.
  const canAutoEnablePlanMode = selectedChat
    ? shouldAutoEnablePlanModeFromChat(selectedChat, supportsPlanMode)
    : false;

  useEffect(() => {
    if (!selectedThreadId || isOpeningChat || !canAutoEnablePlanMode || !latestPlanTurnId) {
      return;
    }

    if (
      dismissedPlanImplementationTurnIdByThreadRef.current[selectedThreadId] === latestPlanTurnId
    ) {
      return;
    }

    if (autoEnabledPlanTurnIdByThreadRef.current[selectedThreadId] === latestPlanTurnId) {
      return;
    }

    autoEnabledPlanTurnIdByThreadRef.current[selectedThreadId] = latestPlanTurnId;
    setSelectedCollaborationMode('plan');
  }, [
    autoEnabledPlanTurnIdByThreadRef,
    canAutoEnablePlanMode,
    dismissedPlanImplementationTurnIdByThreadRef,
    isOpeningChat,
    latestPlanTurnId,
    selectedThreadId,
    setSelectedCollaborationMode,
  ]);

  useEffect(() => {
    if (
      !selectedThreadId ||
      isOpeningChat ||
      hasLatestTurnPlan ||
      selectedCollaborationMode !== 'plan'
    ) {
      return;
    }

    if (!autoEnabledPlanTurnIdByThreadRef.current[selectedThreadId]) {
      return;
    }

    setSelectedCollaborationMode('default');
  }, [
    autoEnabledPlanTurnIdByThreadRef,
    hasLatestTurnPlan,
    isOpeningChat,
    selectedCollaborationMode,
    selectedThreadId,
    setSelectedCollaborationMode,
  ]);

  useEffect(() => {
    const threadId = selectedChat?.id;
    if (!threadId) {
      return;
    }

    const pendingPrompt = pendingPlanImplementationPrompts[threadId];
    if (!pendingPrompt) {
      return;
    }

    const latestTurnPlanTurnId = selectedChat?.latestTurnPlan?.turnId ?? null;
    if (latestTurnPlanTurnId && latestTurnPlanTurnId === pendingPrompt.turnId) {
      return;
    }

    clearPendingPlanImplementationPrompt(threadId);
  }, [
    clearPendingPlanImplementationPrompt,
    pendingPlanImplementationPrompts,
    selectedChat?.id,
    selectedChat?.latestTurnPlan?.turnId,
  ]);

  const stayInPlanMode = useCallback(() => {
    if (!selectedChatId) {
      return;
    }

    const prompt = selectedPlanImplementationPrompt;
    if (prompt) {
      dismissedPlanImplementationTurnIdByThreadRef.current[prompt.threadId] = prompt.turnId;
    }
    setSelectedCollaborationMode('plan');
    clearPendingPlanImplementationPrompt(selectedChatId);
  }, [
    clearPendingPlanImplementationPrompt,
    dismissedPlanImplementationTurnIdByThreadRef,
    selectedChatId,
    selectedPlanImplementationPrompt,
    setSelectedCollaborationMode,
  ]);

  const implementPlan = useCallback(async () => {
    if (!selectedChatId) {
      return;
    }

    const prompt = selectedPlanImplementationPrompt;
    if (!prompt) {
      return;
    }

    clearPendingPlanImplementationPrompt(prompt.threadId);
    setSelectedCollaborationMode('default');
    const sent = await sendMessageContent(PLAN_IMPLEMENTATION_CODING_MESSAGE, {
      collaborationMode: 'default',
      clearComposer: false,
      preservePlan: true,
      suppressPlanModeAutoEnable: true,
    });
    if (sent) {
      dismissedPlanImplementationTurnIdByThreadRef.current[prompt.threadId] = prompt.turnId;
    } else {
      setPendingPlanImplementationPrompts((prev) => ({
        ...prev,
        [prompt.threadId]: prompt,
      }));
    }
  }, [
    clearPendingPlanImplementationPrompt,
    dismissedPlanImplementationTurnIdByThreadRef,
    selectedChatId,
    selectedPlanImplementationPrompt,
    sendMessageContent,
    setPendingPlanImplementationPrompts,
    setSelectedCollaborationMode,
  ]);

  useEffect(() => {
    if (!selectedChat || isOpeningChat || !showActivity) {
      return;
    }
    scrollToBottomIfPinned(false);
  }, [isOpeningChat, scrollToBottomIfPinned, selectedChat, showActivity]);

  useEffect(() => {
    const threadId = selectedChat?.id;
    const turnId = selectedThreadPlan?.turnId;
    if (!threadId || !turnId) {
      return;
    }

    const previousTurnId = planPanelLastTurnByThreadRef.current[threadId];
    if (previousTurnId === turnId) {
      return;
    }

    planPanelLastTurnByThreadRef.current[threadId] = turnId;
    setPlanPanelCollapsedByThread((prev) => {
      if (prev[threadId] === false) {
        return prev;
      }
      return {
        ...prev,
        [threadId]: false,
      };
    });
  }, [
    planPanelLastTurnByThreadRef,
    selectedChat?.id,
    selectedThreadPlan?.turnId,
    setPlanPanelCollapsedByThread,
  ]);

  return {
    stayInPlanMode,
    implementPlan,
  };
}

export type MainScreenPlanExecutionActionsResult = ReturnType<
  typeof useMainScreenPlanExecutionActions
>;
