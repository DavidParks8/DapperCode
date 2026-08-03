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
import {
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedEffortAtom,
} from '../state/models';
import { screenSetter } from '../state/registry';
import { activityAtom } from '../state/composer';
import type { ChatMessage as ChatTranscriptMessage } from '@bridge/types/types';
import { getMessageText } from '@bridge/messages';
import { resolveEquivalentChat } from '../state/chatState';
import {
  normalizeChatMessageMatchContent,
  shouldAutoEnablePlanModeFromChat,
} from '../helpers/helpers';
import type { MainScreenSlashCommandHandlerContext } from '../composer/slashCommandHandler';

export async function executePlanCommand(
  context: MainScreenSlashCommandHandlerContext,
  argText: string,
): Promise<boolean> {
  const {
    selectedChatId,
    submissionController,
    draftController,
    selectedChatIdRef,
    selectedChatRef,
    setDraft,
    stopRequestedRef,
    turnExecutionController,
    activeAgentId,
    preferredStartCwd,
    activeModelId,
    activeEffort,
    activeServiceTier,
    activeApprovalPolicy,
    onLastUsedThreadSettingsChange,
    queueOptimisticUserMessage,
    setSelectedChatId,
    setSelectedChat,
    bumpRunWatchdog,
    registerTurnStarted,
    mergeChatWithPendingOptimisticMessages,
    rememberChatModelPreference,
    clearRunWatchdog,
    discardOptimisticUserMessage,
    handleTurnFailure,
    cacheThreadPlan,
    selectedChat,
    scrollToBottomReliable,
    store,
  } = context;
  const setSending = screenSetter(store, sendingAtom);
  const setCreating = screenSetter(store, creatingAtom);
  const setError = screenSetter(store, errorAtom);
  const setPendingUserInputRequest = screenSetter(store, pendingUserInputRequestAtom);
  const setUserInputDrafts = screenSetter(store, userInputDraftsAtom);
  const setUserInputError = screenSetter(store, userInputErrorAtom);
  const setResolvingUserInput = screenSetter(store, resolvingUserInputAtom);
  const setActivePlan = screenSetter(store, activePlanAtom);
  const setActiveTurnId = screenSetter(store, activeTurnIdAtom);
  const setStoppingTurn = screenSetter(store, stoppingTurnAtom);
  const selectedEffort = store.get(selectedEffortAtom);
  const selectedAcpModeId = store.get(selectedAcpModeIdAtom);
  const setSelectedCollaborationMode = screenSetter(store, selectedCollaborationModeAtom);
  const setActivity = screenSetter(store, activityAtom);
  const lowered = argText.toLowerCase();
  const setPlanMode = (mode: 'plan' | 'default', title: string) => {
    setSelectedCollaborationMode(mode);
    setActivity({
      tone: 'complete',
      title,
    });
    setError(null);
  };

  const resetPlanTurnState = (activityTitle: string, targetChatId?: string) => {
    setActiveTurnId(null);
    setStoppingTurn(false);
    stopRequestedRef.current = false;
    setActivePlan(null);
    if (targetChatId) {
      cacheThreadPlan(targetChatId, null);
    }
    setPendingUserInputRequest(null);
    setUserInputDrafts({});
    setUserInputError(null);
    setResolvingUserInput(false);
    setActivity({
      tone: 'running',
      title: activityTitle,
    });
  };

  const createOptimisticMessage = (): ChatTranscriptMessage => ({
    id: `msg-${Date.now()}`,
    role: 'user',
    content: argText,
    createdAt: new Date().toISOString(),
  });

  const beginPlanSubmission = () =>
    submissionController.begin(
      { ...draftController.snapshot(), value: argText },
      { mentions: [], localImages: [] },
    );

  const createPlanChat = (submissionId: string) =>
    turnExecutionController.create(
      {
        agentId: activeAgentId ?? undefined,
        cwd: preferredStartCwd ?? undefined,
        model: activeModelId ?? undefined,
        effort: activeEffort ?? undefined,
        serviceTier: activeServiceTier ?? undefined,
        approvalPolicy: activeApprovalPolicy,
        collaborationMode: 'plan',
        agentMode: selectedAcpModeId,
      },
      submissionId,
    );

  const createNewChatVisibility = () => {
    let createdChatId: string | null = null;
    let adoptedCreatedChat = false;
    return {
      markCreated(id: string) {
        createdChatId = id;
      },
      markAdopted() {
        adoptedCreatedChat = true;
      },
      getCreatedChatId() {
        return createdChatId;
      },
      isVisible() {
        return createdChatId
          ? selectedChatIdRef.current === createdChatId ||
              (adoptedCreatedChat && selectedChatIdRef.current === null)
          : selectedChatIdRef.current === null;
      },
    };
  };

  const adoptCreatedPlanChat = (
    created: Awaited<ReturnType<typeof createPlanChat>>,
    optimisticMessage: ChatTranscriptMessage,
  ) => {
    if (selectedChatIdRef.current !== null) {
      return;
    }
    setSelectedChatId(created.id);
    setSelectedChat({
      ...created,
      status: 'running',
      updatedAt: new Date().toISOString(),
      statusUpdatedAt: new Date().toISOString(),
      lastMessagePreview: argText.slice(0, 50),
      messages: [...created.messages, optimisticMessage],
    });
    setActivity({
      tone: 'running',
      title: 'Sending plan prompt',
    });
    bumpRunWatchdog();
  };

  const sendPlanPrompt = (chatId: string, cwd: string | null | undefined, submissionId: string) =>
    turnExecutionController.send(
      chatId,
      {
        content: argText,
        cwd: cwd ?? preferredStartCwd ?? undefined,
        model: activeModelId ?? undefined,
        effort: activeEffort ?? undefined,
        serviceTier: activeServiceTier ?? undefined,
        approvalPolicy: activeApprovalPolicy,
        collaborationMode: 'plan',
        agent: null,
      },
      submissionId,
      (turnId) => registerTurnStarted(chatId, turnId),
    );

  const finalizeNewChatPlanSuccess = (
    createdChatId: string,
    resolvedUpdated: Awaited<ReturnType<typeof sendPlanPrompt>>,
    isStillVisible: boolean,
  ) => {
    const autoEnabledPlan = shouldAutoEnablePlanModeFromChat(resolvedUpdated);
    if (autoEnabledPlan && isStillVisible) {
      setSelectedCollaborationMode('plan');
    }
    rememberChatModelPreference(
      createdChatId,
      activeModelId,
      selectedEffort ?? activeEffort,
      activeServiceTier,
    );
    if (!isStillVisible) {
      return;
    }
    setSelectedChat(resolvedUpdated);
    setError(null);
    setActivity({
      tone: 'complete',
      title: 'Turn completed',
      detail: autoEnabledPlan ? 'Plan mode enabled for the next turn' : undefined,
    });
    clearRunWatchdog();
  };

  const restoreFailedPlanDraft = (planSubmission: ReturnType<typeof beginPlanSubmission>) => {
    if (submissionController.fail(planSubmission, draftController.snapshot())) {
      setDraft(planSubmission.draft);
    }
  };

  if (!argText || lowered === 'on' || lowered === 'enable' || lowered === 'enabled') {
    setPlanMode('plan', 'Plan mode enabled');
    return true;
  }

  if (
    lowered === 'off' ||
    lowered === 'disable' ||
    lowered === 'disabled' ||
    lowered === 'default' ||
    lowered === 'chat'
  ) {
    setPlanMode('default', 'Default mode enabled');
    return true;
  }

  const runPlanForNewChat = async (): Promise<boolean> => {
    const planSubmission = beginPlanSubmission();
    const optimisticMessage = createOptimisticMessage();
    const visibility = createNewChatVisibility();

    setDraft('');
    submissionController.markCleared(planSubmission, draftController.snapshot().revision);
    try {
      setCreating(true);
      resetPlanTurnState('Creating chat');
      const created = await createPlanChat(planSubmission.id);
      visibility.markCreated(created.id);
      if (activeAgentId) {
        onLastUsedThreadSettingsChange?.(activeAgentId, 'plan');
      }

      queueOptimisticUserMessage(created.id, optimisticMessage, {
        baseChat: created,
      });
      if (selectedChatIdRef.current === null) {
        visibility.markAdopted();
        adoptCreatedPlanChat(created, optimisticMessage);
      }

      const updated = await sendPlanPrompt(created.id, created.cwd, planSubmission.id);
      const resolvedUpdated = mergeChatWithPendingOptimisticMessages(updated);
      finalizeNewChatPlanSuccess(created.id, resolvedUpdated, visibility.isVisible());
      submissionController.succeed(planSubmission);
    } catch (err) {
      restoreFailedPlanDraft(planSubmission);
      const createdChatId = visibility.getCreatedChatId();
      if (createdChatId) {
        discardOptimisticUserMessage(createdChatId, optimisticMessage.id);
      }
      if (visibility.isVisible()) {
        handleTurnFailure(err);
      }
    } finally {
      if (visibility.isVisible()) {
        setCreating(false);
      }
    }
    return true;
  };

  const runPlanForExistingChat = async (targetChatId: string): Promise<boolean> => {
    const optimisticMessage = createOptimisticMessage();
    const planSubmission = beginPlanSubmission();

    try {
      setSending(true);
      resetPlanTurnState('Sending plan prompt', targetChatId);
      bumpRunWatchdog();
      setDraft('');
      submissionController.markCleared(planSubmission, draftController.snapshot().revision);
      queueOptimisticUserMessage(targetChatId, optimisticMessage);
      setSelectedChat((prev) => {
        const baseChat =
          selectedChat?.id === targetChatId
            ? selectedChat
            : prev?.id === targetChatId
              ? prev
              : prev;
        if (!baseChat) {
          return prev;
        }
        const nowIso = new Date().toISOString();
        return {
          ...baseChat,
          status: 'running',
          updatedAt: nowIso,
          statusUpdatedAt: nowIso,
          lastError: undefined,
          lastMessagePreview:
            normalizeChatMessageMatchContent(getMessageText(optimisticMessage)).slice(0, 120) ||
            baseChat.lastMessagePreview,
          messages: [...baseChat.messages, optimisticMessage],
        };
      });
      scrollToBottomReliable(true);
      const updated = await turnExecutionController.send(
        targetChatId,
        {
          content: argText,
          cwd: selectedChat?.cwd,
          model: activeModelId ?? undefined,
          effort: activeEffort ?? undefined,
          serviceTier: activeServiceTier ?? undefined,
          approvalPolicy: activeApprovalPolicy,
          collaborationMode: 'plan',
          agent: null,
        },
        planSubmission.id,
        (turnId) => registerTurnStarted(targetChatId, turnId),
      );
      const currentChat =
        selectedChatRef.current?.id === targetChatId ? selectedChatRef.current : null;
      const resolvedUpdated = mergeChatWithPendingOptimisticMessages(
        currentChat ? resolveEquivalentChat(currentChat, updated) : updated,
      );
      rememberChatModelPreference(
        targetChatId,
        activeModelId,
        selectedEffort ?? activeEffort,
        activeServiceTier,
      );
      if (selectedChatIdRef.current === targetChatId) {
        setSelectedChat(resolvedUpdated);
        setError(null);
        setActivity({
          tone: 'complete',
          title: 'Turn completed',
        });
        clearRunWatchdog();
      }
      submissionController.succeed(planSubmission);
    } catch (err) {
      if (submissionController.fail(planSubmission, draftController.snapshot())) {
        setDraft(planSubmission.draft);
      }
      discardOptimisticUserMessage(targetChatId, optimisticMessage.id);
      if (selectedChatIdRef.current === targetChatId) {
        handleTurnFailure(err);
      }
    } finally {
      if (selectedChatIdRef.current === targetChatId) {
        setSending(false);
      }
    }
    return true;
  };

  setSelectedCollaborationMode('plan');
  return selectedChatId ? runPlanForExistingChat(selectedChatId) : runPlanForNewChat();
}
