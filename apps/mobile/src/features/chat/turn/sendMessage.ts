import {
  activeBridgeUiSurfacesAtom,
  activePlanAtom,
  activeTurnIdAtom,
  errorAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  sendingAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../state/turn';
import { selectedCollaborationModeAtom, selectedEffortAtom } from '../state/models';
import { screenSetter } from '../state/registry';
import { activityAtom, showDelayedGenericRunningActivityAtom } from '../state/composer';
import { interruptedChatCreationAtom } from '@shell/state/chat/atoms';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import {
  consumeInterruptedChatCreationAtom,
  replaceInterruptedChatSubmissionAtom,
} from '@shell/state/chat/actions';
import { interruptedCreationRetryId } from '@shell/session/interruptedChatCreation';
import type { InterruptedChatCreation } from '@shell/session/interruptedChatCreation';
import type { CollaborationMode, LocalImageInput, MentionInput } from '@bridge/types/types';
import type { MainScreenSendMessageHandlerContext } from './sendMessageHandler';
import { submissionScopeKey, type ComposerSubmission } from './controllers/submissionController';
import {
  applyQueuedMessageResult,
  applyStartedTurnResult,
  createOptimisticSendState,
  finalizeSuccessfulSubmission,
  beginSendMessageSubmission,
  prepareSendMessageRequest,
  restoreFailedSubmission,
  type RunSendMessageTurnArgs,
} from './sendMessageState';

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

export type BeginSendMessageSubmissionArgs = {
  rawContent: string;
  options?: SendMessageOptions;
  selectedCollaborationMode: CollaborationMode;
  selectedChat?: RunSendMessageTurnArgs['selectedChat'];
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  submissionController: MainScreenSendMessageHandlerContext['submissionController'];
  draftController: MainScreenSendMessageHandlerContext['draftController'];
  interruptedSubmissionId?: string;
  inheritClearedDraftsFromSubmissionId?: string;
  inheritedClearedDraftEntries?: Array<{ scopeKey: string; draft: string }>;
};

function resolveInterruptedSendRecovery(options: {
  interrupted: InterruptedChatCreation | null;
  targetChatId: string;
  content: string;
  sendOptions?: SendMessageOptions;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  sameProfile: boolean;
  targetChat: RunSendMessageTurnArgs['selectedChat'];
}): { pendingChatId: string | null; submissionId: string | undefined } {
  const interrupted = options.interrupted;
  if (!interrupted || interrupted.createdChatId !== options.targetChatId) {
    return { pendingChatId: null, submissionId: undefined };
  }
  return {
    pendingChatId: interrupted.pendingChatId,
    submissionId: interruptedCreationRetryId(
      interrupted,
      options.content,
      (options.sendOptions?.mentions ?? options.pendingMentionPaths).map((mention) =>
        typeof mention === 'string' ? mention : mention.path,
      ),
      (options.sendOptions?.localImages ?? options.pendingLocalImagePaths).map((image) =>
        typeof image === 'string' ? image : image.path,
      ),
      options.sameProfile,
      options.targetChat?.agentId ?? null,
      options.targetChat?.cwd ?? null,
    ),
  };
}

function interruptedClearedDraftEntries(
  interrupted: InterruptedChatCreation | null,
  targetChatId: string,
  profileId: string,
): Array<{ scopeKey: string; draft: string }> | undefined {
  if (interrupted?.createdChatId !== targetChatId) {
    return undefined;
  }
  return [
    {
      scopeKey: submissionScopeKey({ profileId, threadId: null }),
      draft: interrupted.originalDraft ?? interrupted.draft,
    },
  ];
}

function interruptedPredecessorId(
  interrupted: InterruptedChatCreation | null,
  targetChatId: string,
): string | undefined {
  return interrupted?.createdChatId === targetChatId ? interrupted.submissionId : undefined;
}

function acceptedReplacementChat(
  result: { chat: RunSendMessageTurnArgs['selectedChat'] },
  targetChatId: string,
  fallback: RunSendMessageTurnArgs['selectedChat'],
) {
  return result.chat?.id === targetChatId ? result.chat : (fallback ?? null);
}

async function persistChangedInterruptedSubmission(options: {
  context: MainScreenSendMessageHandlerContext;
  interrupted: InterruptedChatCreation | null;
  pendingChatId: string | null;
  submission: ComposerSubmission;
  content: string;
  hadAttachments: boolean;
  shouldClearComposer: boolean;
  targetChat: RunSendMessageTurnArgs['selectedChat'];
}): Promise<string | null> {
  const { context, interrupted, pendingChatId, submission } = options;
  if (!pendingChatId || !interrupted || submission.id === interrupted.submissionId) {
    return pendingChatId;
  }
  try {
    const replacement = await context.store.set(replaceInterruptedChatSubmissionAtom, {
      profileId: context.bridgeProfileId,
      expectedPendingChatId: pendingChatId,
      submissionId: submission.id,
      draft: options.content,
      hadAttachments: options.hadAttachments,
      agentId: options.targetChat?.agentId ?? null,
      cwd: options.targetChat?.cwd ?? null,
    });
    if (replacement) {
      return replacement.pendingChatId;
    }
  } catch (error) {
    context.store.set(errorAtom, (error as Error).message);
  }
  restorePreparedSubmission(context, submission, options.shouldClearComposer);
  return null;
}

function prepareSubmissionForDispatch(
  context: MainScreenSendMessageHandlerContext,
  submission: ComposerSubmission,
  shouldClearComposer: boolean,
): void {
  if (!shouldClearComposer) {
    return;
  }
  context.attachmentController.beginSubmission();
  const clearedRevision = context.draftController.clearForSubmission({
    scopeKey: submission.scopeKey,
    value: submission.draft,
    revision: submission.draftRevision,
  });
  if (clearedRevision !== null) {
    context.submissionController.markCleared(submission, submission.scopeKey, clearedRevision);
  }
}

function restorePreparedSubmission(
  context: MainScreenSendMessageHandlerContext,
  submission: ComposerSubmission,
  shouldClearComposer: boolean,
): void {
  if (!shouldClearComposer) {
    return;
  }
  const shouldRestoreDraft = context.submissionController.fail(
    submission,
    context.draftController.snapshot(),
  );
  context.attachmentController.finishSubmission(false, shouldRestoreDraft);
  if (shouldRestoreDraft) {
    context.setDraft(submission.draft);
  }
}

async function runSendMessageTurn(args: RunSendMessageTurnArgs) {
  try {
    const isSelectedForDispatch = args.selectedChatIdRef.current === args.targetChatId;
    if (isSelectedForDispatch) {
      args.setSending(true);
      args.setActivity({ tone: 'running', title: 'Sending message' });
      args.bumpRunWatchdog();
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
    if (result.disposition === 'sent') {
      args.optimisticState.promoteQueuedToSentMessage();
    }
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
      await args.consumeInterruptedChatCreation(args.selectedChat ?? null);
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
      interruptLatestTurn: (threadId) => args.interruptLatestTurn(threadId),
      setActiveTurnId: (value) => args.setActiveTurnId(value),
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
    await args.consumeInterruptedChatCreation(
      acceptedReplacementChat(result, args.targetChatId, args.selectedChat),
    );
    return true;
  } catch (err) {
    restoreFailedSubmission(args);
    args.optimisticState.restoreGoalSurfaces();
    args.optimisticState.clearSentMessage();
    args.discardOptimisticQueuedMessage(
      args.targetChatId,
      args.optimisticState.optimisticQueuedMessage?.id,
    );
    if (args.selectedChatIdRef.current === args.targetChatId) {
      args.handleTurnFailure(err);
    }
    return false;
  } finally {
    if (args.selectedChatIdRef.current === args.targetChatId) {
      args.setSending(false);
    }
  }
}

export async function executeSendMessage(
  context: MainScreenSendMessageHandlerContext,
  rawContent: string,
  options?: SendMessageOptions,
): Promise<boolean> {
  const {
    selectedChatId,
    bridgeProfileId,
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
    interruptLatestTurn,
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
  const setActiveTurnId = screenSetter(store, activeTurnIdAtom);
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
  const targetChatAtStart =
    selectedChatRef.current?.id === targetChatId ? selectedChatRef.current : selectedChat;
  const interruptedAtStart = store.get(interruptedChatCreationAtom);
  const { pendingChatId: initialInterruptedPendingChatId, submissionId: interruptedSubmissionId } =
    resolveInterruptedSendRecovery({
      interrupted: interruptedAtStart,
      targetChatId,
      content,
      sendOptions: options,
      pendingMentionPaths,
      pendingLocalImagePaths,
      sameProfile: store.get(activeBridgeProfileAtom)?.id === bridgeProfileId,
      targetChat: targetChatAtStart,
    });
  let interruptedPendingChatId = initialInterruptedPendingChatId;
  const consumeInterruptedChatCreation = async (chat: typeof selectedChatRef.current) => {
    if (!interruptedPendingChatId || !chat || chat.id !== targetChatId) {
      return;
    }
    await store.set(consumeInterruptedChatCreationAtom, {
      expectedPendingChatId: interruptedPendingChatId,
      profileId: bridgeProfileId,
      replacement: chat,
    });
  };
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
      selectedChat: targetChatAtStart,
      pendingMentionPaths,
      pendingLocalImagePaths,
      submissionController,
      draftController,
      interruptedSubmissionId,
      inheritClearedDraftsFromSubmissionId: interruptedPredecessorId(
        interruptedAtStart,
        targetChatId,
      ),
      inheritedClearedDraftEntries: interruptedClearedDraftEntries(
        interruptedAtStart,
        targetChatId,
        bridgeProfileId,
      ),
    });
  prepareSubmissionForDispatch(context, submission, shouldClearComposer);
  interruptedPendingChatId = await persistChangedInterruptedSubmission({
    context,
    interrupted: interruptedAtStart,
    pendingChatId: interruptedPendingChatId,
    submission,
    content,
    hadAttachments: turnMentions.length > 0 || turnLocalImages.length > 0,
    shouldClearComposer,
    targetChat: targetChatAtStart,
  });
  if (initialInterruptedPendingChatId && !interruptedPendingChatId) {
    return false;
  }
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
    selectedChat: targetChatAtStart,
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
    interruptLatestTurn,
    setActiveTurnId,
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
    consumeInterruptedChatCreation,
  });
}
