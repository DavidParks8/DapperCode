import {
  activeBridgeUiSurfacesAtom,
  activePlanAtom,
  errorAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  sendingAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import { selectedCollaborationModeAtom, selectedEffortAtom } from '../../state/mainScreen/models';
import { screenSetter } from '../../state/mainScreen/registry';
import {
  activityAtom,
  showDelayedGenericRunningActivityAtom,
} from '../../state/mainScreen/composer';
import type { CollaborationMode, LocalImageInput, MentionInput } from '../../api/types';
import type { MainScreenSendMessageHandlerContext } from './mainScreenSendMessageHandler';
import type { ComposerSubmission } from './controllers/submissionController';
import {
  applyQueuedMessageResult,
  applyStartedTurnResult,
  createOptimisticSendState,
  finalizeSuccessfulSubmission,
  beginSendMessageSubmission,
  prepareSendMessageRequest,
  restoreFailedSubmission,
  type RunSendMessageTurnArgs,
} from './mainScreenSendMessageState';

export interface SendMessageOptions {
  allowSlashCommands?: boolean;
  collaborationMode?: CollaborationMode;
  mentions?: MentionInput[];
  localImages?: LocalImageInput[];
  clearComposer?: boolean;
  preservePlan?: boolean;
  suppressPlanModeAutoEnable?: boolean;
  submission?: ComposerSubmission;
}

async function runSendMessageTurn(args: RunSendMessageTurnArgs) {
  try {
    args.setSending(true);
    args.setActivity({ tone: 'running', title: 'Sending message' });
    args.bumpRunWatchdog();
    if (args.shouldClearComposer) {
      args.attachmentController.beginSubmission();
      args.setDraft('');
      args.submissionController.markCleared(
        args.submission,
        args.draftController.snapshot().revision,
      );
    }
    args.optimisticState.applyGoalSurface();
    args.optimisticState.applySentMessage();
    const result = await args.turnExecutionController.sendOrQueue(
      args.targetChatId,
      {
        content: args.content,
        mentions: args.turnMentions,
        localImages: args.turnLocalImages,
        cwd: args.selectedChat?.cwd,
        model: args.activeModelId ?? undefined,
        effort: args.activeEffort ?? undefined,
        serviceTier: args.activeServiceTier ?? undefined,
        approvalPolicy: args.activeApprovalPolicy,
        collaborationMode: args.resolvedCollaborationMode,
      },
      args.optimisticState.likelyQueuesLocally,
      args.submission.id,
    );
    args.discardOptimisticQueuedMessage(
      args.targetChatId,
      args.optimisticState.optimisticQueuedMessage?.id,
    );
    args.cacheThreadQueueState(args.targetChatId, result.queue);
    args.rememberChatModelPreference(
      args.targetChatId,
      args.activeModelId,
      args.selectedEffort ?? args.activeEffort,
      args.activeServiceTier,
    );
    const isStillSelectedForResult = args.selectedChatIdRef.current === args.targetChatId;
    finalizeSuccessfulSubmission(args, isStillSelectedForResult);
    if (result.disposition === 'queued') {
      applyQueuedMessageResult({
        optimisticState: args.optimisticState,
        selectedChatIdRef: args.selectedChatIdRef,
        targetChatId: args.targetChatId,
        selectedChatRef: args.selectedChatRef,
        setActivity: args.setActivity,
        clearRunWatchdog: args.clearRunWatchdog,
      });
      return true;
    }
    applyStartedTurnResult({
      result,
      targetChatId: args.targetChatId,
      selectedChatIdRef: args.selectedChatIdRef,
      registerTurnStarted: args.registerTurnStarted,
      setStoppingTurn: args.setStoppingTurn,
      stopRequestedRef: args.stopRequestedRef,
      shouldPreservePlan: args.shouldPreservePlan,
      setActivePlan: args.setActivePlan,
      cacheThreadPlan: args.cacheThreadPlan,
      setPendingUserInputRequest: args.setPendingUserInputRequest,
      setUserInputDrafts: args.setUserInputDrafts,
      setUserInputError: args.setUserInputError,
      setResolvingUserInput: args.setResolvingUserInput,
      selectedChatRef: args.selectedChatRef,
      mergeChatWithPendingOptimisticMessages: args.mergeChatWithPendingOptimisticMessages,
      suppressPlanModeAutoEnable: args.suppressPlanModeAutoEnable,
      supportsPlanMode: args.supportsPlanMode,
      setSelectedCollaborationMode: args.setSelectedCollaborationMode,
      setSelectedChat: args.setSelectedChat,
      resolvedCollaborationMode: args.resolvedCollaborationMode,
      optimisticState: args.optimisticState,
      setActivity: args.setActivity,
      clearRunWatchdog: args.clearRunWatchdog,
      setShowDelayedGenericRunningActivity: args.setShowDelayedGenericRunningActivity,
      bumpRunWatchdog: args.bumpRunWatchdog,
    });
    return true;
  } catch (err) {
    restoreFailedSubmission(args);
    args.optimisticState.restoreGoalSurfaces();
    args.optimisticState.clearSentMessage();
    args.discardOptimisticQueuedMessage(
      args.targetChatId,
      args.optimisticState.optimisticQueuedMessage?.id,
    );
    if (args.selectedChatIdRef.current === args.targetChatId) args.handleTurnFailure(err);
    return false;
  } finally {
    if (args.selectedChatIdRef.current === args.targetChatId) args.setSending(false);
  }
}

export async function executeSendMessage(
  context: MainScreenSendMessageHandlerContext,
  rawContent: string,
  options?: SendMessageOptions,
): Promise<boolean> {
  const {
    selectedChatId,
    handleSlashCommand,
    setDraft,
    pendingMentionPaths,
    selectedChat,
    pendingLocalImagePaths,
    submissionController,
    draftController,
    threadRuntimeSnapshotsRef,
    supportsGoal,
    replaceThreadBridgeUiSurfaces,
    selectedChatIdRef,
    activeTurnIdRef,
    selectedChatRef,
    queueOptimisticQueuedMessage,
    discardOptimisticUserMessage,
    setSelectedChat,
    bumpRunWatchdog,
    attachmentController,
    queueOptimisticUserMessage,
    scrollToBottomReliable,
    turnExecutionController,
    activeModelId,
    activeEffort,
    activeServiceTier,
    activeApprovalPolicy,
    discardOptimisticQueuedMessage,
    cacheThreadQueueState,
    rememberChatModelPreference,
    clearRunWatchdog,
    registerTurnStarted,
    stopRequestedRef,
    cacheThreadPlan,
    mergeChatWithPendingOptimisticMessages,
    supportsPlanMode,
    handleTurnFailure,
    store,
  } = context;
  const pendingApproval = store.get(pendingApprovalAtom);
  const pendingUserInputRequest = store.get(pendingUserInputRequestAtom);
  const activeBridgeUiSurfaces = store.get(activeBridgeUiSurfacesAtom);
  const setSending = screenSetter(store, sendingAtom);
  const setError = screenSetter(store, errorAtom);
  const setPendingUserInputRequest = screenSetter(store, pendingUserInputRequestAtom);
  const setUserInputDrafts = screenSetter(store, userInputDraftsAtom);
  const setUserInputError = screenSetter(store, userInputErrorAtom);
  const setResolvingUserInput = screenSetter(store, resolvingUserInputAtom);
  const setActivePlan = screenSetter(store, activePlanAtom);
  const setActiveBridgeUiSurfaces = screenSetter(store, activeBridgeUiSurfacesAtom);
  const setStoppingTurn = screenSetter(store, stoppingTurnAtom);
  const selectedEffort = store.get(selectedEffortAtom);
  const selectedCollaborationMode = store.get(selectedCollaborationModeAtom);
  const setSelectedCollaborationMode = screenSetter(store, selectedCollaborationModeAtom);
  const setActivity = screenSetter(store, activityAtom);
  const setShowDelayedGenericRunningActivity = screenSetter(
    store,
    showDelayedGenericRunningActivityAtom,
  );

  const request = prepareSendMessageRequest({
    rawContent,
    options,
    selectedChatId,
  });
  if (!request) {
    return false;
  }
  const { content, targetChatId, shouldClearComposer, shouldPreservePlan } = request;
  if (options?.allowSlashCommands && (await handleSlashCommand(content))) {
    if (shouldClearComposer) {
      setDraft('');
    }
    return true;
  }
  const { resolvedCollaborationMode, turnMentions, turnLocalImages, submission } =
    beginSendMessageSubmission({
      rawContent,
      options,
      selectedCollaborationMode,
      selectedChat,
      pendingMentionPaths,
      pendingLocalImagePaths,
      submissionController,
      draftController,
    });
  const selectedThreadSnapshot = threadRuntimeSnapshotsRef.current[targetChatId] ?? null;
  const optimisticState = createOptimisticSendState({
    targetChatId,
    content,
    turnMentions,
    turnLocalImages,
    supportsGoal,
    selectedThreadSnapshot,
    activeBridgeUiSurfaces,
    replaceThreadBridgeUiSurfaces,
    selectedChatIdRef,
    setActiveBridgeUiSurfaces,
    activeTurnId: activeTurnIdRef.current,
    selectedChat: selectedChatRef.current,
    pendingApproval,
    pendingUserInputRequest,
    queueOptimisticQueuedMessage,
    queueOptimisticUserMessage,
    discardOptimisticUserMessage,
    setSelectedChat,
    selectedChatState: selectedChat,
    selectedChatRef,
    scrollToBottomReliable,
  });
  return runSendMessageTurn({
    targetChatId,
    content,
    turnMentions,
    turnLocalImages,
    selectedChat,
    activeModelId,
    activeEffort,
    activeServiceTier,
    activeApprovalPolicy,
    resolvedCollaborationMode,
    selectedEffort,
    shouldClearComposer,
    shouldPreservePlan,
    submission,
    submissionController,
    draftController,
    setDraft,
    attachmentController,
    setSending,
    setActivity,
    bumpRunWatchdog,
    optimisticState,
    turnExecutionController,
    discardOptimisticQueuedMessage,
    cacheThreadQueueState,
    rememberChatModelPreference,
    clearRunWatchdog,
    selectedChatIdRef,
    setError,
    selectedChatRef,
    registerTurnStarted,
    setStoppingTurn,
    stopRequestedRef,
    setActivePlan,
    cacheThreadPlan,
    setPendingUserInputRequest,
    setUserInputDrafts,
    setUserInputError,
    setResolvingUserInput,
    mergeChatWithPendingOptimisticMessages,
    supportsPlanMode,
    setSelectedCollaborationMode,
    setSelectedChat,
    setShowDelayedGenericRunningActivity,
    suppressPlanModeAutoEnable: options?.suppressPlanModeAutoEnable ?? false,
    handleTurnFailure,
  });
}
