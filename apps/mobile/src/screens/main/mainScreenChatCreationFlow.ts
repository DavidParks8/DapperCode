import {
  activePlanAtom,
  activeTurnIdAtom,
  creatingAtom,
  errorAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import {
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedEffortAtom,
} from '../../state/mainScreen/models';
import { activityAtom } from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import { shouldAutoEnablePlanModeFromChat } from './mainScreenHelpers';
import type {
  MainScreenAgentThreadEventBootstrapContext,
  MainScreenAgentThreadEventBootstrapResult,
} from './mainScreenAgentThreadEventBootstrap';
import {
  buildOptimisticChatSetup,
  createChatVisibilityTracker,
  createOnChatCreatedHandler,
  handleCreateChatFailure,
  resetChatCreationUi,
  showOptimisticChatIfNeeded,
  updateCreatedChatActivity,
} from './mainScreenChatCreationHelpers';

export type MainScreenChatCreationFlowContext = MainScreenAgentThreadEventBootstrapContext &
  MainScreenAgentThreadEventBootstrapResult;
export function useMainScreenChatCreationFlow(context: MainScreenChatCreationFlowContext) {
  const {
    activeAgentId,
    activeApprovalPolicy,
    activeEffort,
    activeModelId,
    activeServiceTier,
    attachmentController,
    bumpRunWatchdog,
    clearRunWatchdog,
    discardOptimisticUserMessage,
    draftController,
    handleSlashCommand,
    handleTurnFailure,
    mergeChatWithPendingOptimisticMessages,
    onLastUsedThreadSettingsChange,
    pendingLocalImagePaths,
    pendingMentionPaths,
    preferredAgentId,
    preferredStartCwd,
    queueOptimisticUserMessage,
    registerTurnStarted,
    rememberChatModelPreference,
    scrollToBottomReliable,
    selectedChatId,
    selectedChatIdRef,
    selectedChatRef,
    setDraft,
    setSelectedChat,
    setSelectedChatId,
    supportsPlanMode,
    stopRequestedRef,
    submissionController,
    turnExecutionController,
  } = context;
  const setCreating = useSetAtom(creatingAtom);
  const setError = useSetAtom(errorAtom);
  const setPendingUserInputRequest = useSetAtom(pendingUserInputRequestAtom);
  const setUserInputDrafts = useSetAtom(userInputDraftsAtom);
  const setUserInputError = useSetAtom(userInputErrorAtom);
  const setResolvingUserInput = useSetAtom(resolvingUserInputAtom);
  const setActivePlan = useSetAtom(activePlanAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const selectedEffort = useAtomValue(selectedEffortAtom);
  const selectedCollaborationMode = useAtomValue(selectedCollaborationModeAtom);
  const selectedAcpModeId = useAtomValue(selectedAcpModeIdAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const setActivity = useSetAtom(activityAtom);
  const pendingRestoredDraftRef = useRef<string | null>(null);

  useEffect(() => {
    if (pendingRestoredDraftRef.current === null) {
      return;
    }
    const restoredDraft = pendingRestoredDraftRef.current;
    pendingRestoredDraftRef.current = null;
    setDraft(restoredDraft);
  }, [selectedChatId, setDraft]);

  const createChat = useCallback(async () => {
    const draftSnapshot = draftController.snapshot();
    const content = draftSnapshot.value.trim();
    if (!content) {
      return;
    }

    if (await handleSlashCommand(content)) {
      setDraft('');
      return;
    }

    const {
      submission,
      turnMentions,
      turnLocalImages,
      optimisticMessage,
      optimisticChatId,
      optimisticChat,
    } = buildOptimisticChatSetup({
      draftSnapshot,
      content,
      pendingMentionPaths,
      pendingLocalImagePaths,
      preferredStartCwd,
      activeAgentId,
      preferredAgentId,
      submissionController,
    });

    attachmentController.beginSubmission();
    setDraft('');
    submissionController.markCleared(submission, draftController.snapshot().revision);
    showOptimisticChatIfNeeded({
      selectedChatIdRef,
      selectedChatRef,
      optimisticChatId,
      optimisticChat,
      setSelectedChatId,
      setSelectedChat,
      scrollToBottomReliable,
    });

    const tracker = createChatVisibilityTracker(selectedChatIdRef, optimisticChatId);
    try {
      resetChatCreationUi({
        setCreating,
        setActiveTurnId,
        setStoppingTurn,
        stopRequestedRef,
        setActivePlan,
        setPendingUserInputRequest,
        setUserInputDrafts,
        setUserInputError,
        setResolvingUserInput,
        setActivity,
      });
      const updated = await turnExecutionController.createAndStart({
        submissionId: submission.id,
        create: {
          agentId: activeAgentId ?? undefined,
          cwd: preferredStartCwd ?? undefined,
          model: activeModelId ?? undefined,
          effort: activeEffort ?? undefined,
          serviceTier: activeServiceTier ?? undefined,
          approvalPolicy: activeApprovalPolicy,
          collaborationMode: selectedCollaborationMode,
          agentMode: selectedAcpModeId,
        },
        message: (created) => ({
          content,
          mentions: turnMentions,
          localImages: turnLocalImages,
          cwd: created.cwd ?? preferredStartCwd ?? undefined,
          model: activeModelId ?? undefined,
          effort: activeEffort ?? undefined,
          serviceTier: activeServiceTier ?? undefined,
          approvalPolicy: activeApprovalPolicy,
          collaborationMode: selectedCollaborationMode,
        }),
        onCreated: createOnChatCreatedHandler({
          tracker,
          activeAgentId,
          selectedCollaborationMode,
          onLastUsedThreadSettingsChange,
          queueOptimisticUserMessage,
          optimisticMessage,
          selectedChatIdRef,
          optimisticChatId,
          setSelectedChatId,
          selectedChatRef,
          setSelectedChat,
          scrollToBottomReliable,
          setActivity,
          bumpRunWatchdog,
          content,
        }),
        onTurnStarted: registerTurnStarted,
      });
      const resolvedUpdated = mergeChatWithPendingOptimisticMessages(updated);
      const autoEnabledPlan = shouldAutoEnablePlanModeFromChat(resolvedUpdated, supportsPlanMode);
      const isStillVisible = tracker.isVisible();
      if (autoEnabledPlan && isStillVisible) {
        setSelectedCollaborationMode('plan');
      }
      rememberChatModelPreference(
        tracker.createdChatId,
        activeModelId,
        selectedEffort ?? activeEffort,
        activeServiceTier,
      );
      submissionController.succeed(submission);
      if (!isStillVisible) {
        attachmentController.finishSubmission(false);
      }
      if (isStillVisible) {
        setSelectedChat(resolvedUpdated);
        attachmentController.finishSubmission(true);
        setError(null);
        updateCreatedChatActivity({
          resolvedUpdated,
          autoEnabledPlan,
          selectedCollaborationMode,
          setActivity,
          clearRunWatchdog,
          bumpRunWatchdog,
        });
      }
    } catch (err) {
      handleCreateChatFailure({
        draftController,
        submissionController,
        submission,
        tracker,
        attachmentController,
        pendingRestoredDraftRef,
        setDraft,
        discardOptimisticUserMessage,
        optimisticMessage,
        selectedChatIdRef,
        selectedChatRef,
        optimisticChatId,
        setSelectedChatId,
        setSelectedChat,
        handleTurnFailure,
        error: err,
      });
    } finally {
      if (tracker.isVisible()) {
        setCreating(false);
      }
    }
  }, [
    turnExecutionController,
    attachmentController,
    draftController,
    activeEffort,
    activeAgentId,
    activeModelId,
    activeApprovalPolicy,
    activeServiceTier,
    handleSlashCommand,
    pendingMentionPaths,
    pendingLocalImagePaths,
    preferredStartCwd,
    selectedCollaborationMode,
    registerTurnStarted,
    handleTurnFailure,
    discardOptimisticUserMessage,
    bumpRunWatchdog,
    clearRunWatchdog,
    mergeChatWithPendingOptimisticMessages,
    onLastUsedThreadSettingsChange,
    queueOptimisticUserMessage,
    preferredAgentId,
    rememberChatModelPreference,
    scrollToBottomReliable,
    selectedAcpModeId,
    selectedChatIdRef,
    selectedChatRef,
    selectedEffort,
    setActivePlan,
    setActiveTurnId,
    setActivity,
    setCreating,
    setDraft,
    setError,
    setPendingUserInputRequest,
    setResolvingUserInput,
    setSelectedChat,
    setSelectedChatId,
    setSelectedCollaborationMode,
    setStoppingTurn,
    setUserInputDrafts,
    setUserInputError,
    stopRequestedRef,
    submissionController,
    supportsPlanMode,
  ]);

  return {
    createChat,
  };
}

export type MainScreenChatCreationFlowResult = ReturnType<typeof useMainScreenChatCreationFlow>;
