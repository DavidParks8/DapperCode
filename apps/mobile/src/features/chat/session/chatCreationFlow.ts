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
} from '../state/turn';
import {
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedEffortAtom,
} from '../state/models';
import { activityAtom } from '../state/composer';
import { interruptedChatCreationAtom } from '@shell/state/chat/atoms';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { interruptedCreationRetryId } from '@shell/session/interruptedChatCreation';
import type { InterruptedChatCreation } from '@shell/session/interruptedChatCreation';
import type { Chat } from '@bridge/types/types';
import {
  consumeInterruptedChatCreationAtom,
  linkInterruptedChatCreationAtom,
  persistPendingChatCreationAtom,
} from '@shell/state/chat/actions';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ComposerSubmission,
  submissionScopeKey,
} from '../turn/controllers/submissionController';
import { shouldAutoEnablePlanModeFromChat } from '../helpers/helpers';
import { resolveAcceptedTurnChat } from '../turn/acceptedTurnState';
import type {
  MainScreenAgentThreadEventBootstrapContext,
  MainScreenAgentThreadEventBootstrapResult,
} from '../agents/threadEventBootstrap';
import {
  buildOptimisticChatSetup,
  createChatVisibilityTracker,
  createOnChatCreatedHandler,
  handleCreateChatFailure,
  resetChatCreationUi,
  showOptimisticChatIfNeeded,
  updateCreatedChatActivity,
} from './chatCreationHelpers';

export type MainScreenChatCreationFlowContext = MainScreenAgentThreadEventBootstrapContext &
  MainScreenAgentThreadEventBootstrapResult;

async function consumeRecoveredCreation(
  store: MainScreenChatCreationFlowContext['store'],
  profileId: string,
  pendingChatId: string,
  replacement: Chat,
): Promise<void> {
  const interrupted = store.get(interruptedChatCreationAtom);
  if (!interrupted || interrupted.pendingChatId !== pendingChatId) {
    return;
  }
  await store.set(consumeInterruptedChatCreationAtom, {
    expectedPendingChatId: interrupted.pendingChatId,
    profileId,
    replacement,
  });
}

function pendingChatIdFor(interrupted: InterruptedChatCreation | null): string | undefined {
  return interrupted?.pendingChatId;
}

function clearSubmissionComposer(
  draftController: MainScreenChatCreationFlowContext['draftController'],
  submissionController: MainScreenChatCreationFlowContext['submissionController'],
  submission: ComposerSubmission,
): void {
  const clearedRevision = draftController.clearForSubmission({
    scopeKey: submission.scopeKey,
    value: submission.draft,
    revision: submission.draftRevision,
  });
  if (clearedRevision !== null) {
    submissionController.markCleared(submission, submission.scopeKey, clearedRevision);
  }
}

function interruptedRetryId(options: {
  store: MainScreenChatCreationFlowContext['store'];
  bridgeProfileId: string;
  content: string;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  activeAgentId: string | null;
  preferredAgentId: string | null;
  preferredStartCwd: string | null;
}): { interrupted: InterruptedChatCreation | null; submissionId: string | undefined } {
  const interrupted = options.store.get(interruptedChatCreationAtom);
  return {
    interrupted,
    submissionId: interruptedCreationRetryId(
      interrupted,
      options.content,
      options.pendingMentionPaths,
      options.pendingLocalImagePaths,
      options.store.get(activeBridgeProfileAtom)?.id === options.bridgeProfileId,
      options.activeAgentId ?? options.preferredAgentId,
      options.preferredStartCwd,
    ),
  };
}

function createDraftContent(
  draftController: MainScreenChatCreationFlowContext['draftController'],
): { draftSnapshot: ReturnType<typeof draftController.snapshot>; content: string } | null {
  const draftSnapshot = draftController.snapshot();
  const content = draftSnapshot.value.trim();
  return !draftController.restoring && content ? { draftSnapshot, content } : null;
}

export function useMainScreenChatCreationFlow(context: MainScreenChatCreationFlowContext) {
  const {
    activeAgentId,
    activeApprovalPolicy,
    activeEffort,
    activeModelId,
    activeServiceTier,
    attachmentController,
    bridgeProfileId,
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
    preserveModelSelectionForChat,
    preferredAgentId,
    preferredStartCwd,
    queueOptimisticUserMessage,
    registerTurnStarted,
    rememberChatModelPreference,
    scrollToBottomReliable,
    selectedChatIdRef,
    selectedChatRef,
    setDraft,
    setSelectedChat,
    setSelectedChatId,
    supportsPlanMode,
    stopRequestedRef,
    store,
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
  const linkInterruptedChatCreation = useSetAtom(linkInterruptedChatCreationAtom);
  const persistPendingChatCreation = useSetAtom(persistPendingChatCreationAtom);
  const [pendingRestoredSubmission, setPendingRestoredSubmission] = useState<{
    submission: Pick<ComposerSubmission, 'draft' | 'mentions' | 'localImages'>;
    scopeKey: string;
  } | null>(null);
  const attachmentControllerRef = useRef(attachmentController);
  attachmentControllerRef.current = attachmentController;
  const { restorePending } = attachmentController;
  const { snapshot: draftSnapshot } = draftController;

  useEffect(() => {
    if (pendingRestoredSubmission === null) {
      return;
    }
    const { submission, scopeKey } = pendingRestoredSubmission;
    const current = draftSnapshot();
    if (current.scopeKey === scopeKey) {
      setDraft(submission.draft);
      restorePending(submission);
    }
    setPendingRestoredSubmission(null);
  }, [draftSnapshot, pendingRestoredSubmission, restorePending, setDraft]);

  const createChat = useCallback(async () => {
    const preparedDraft = createDraftContent(draftController);
    if (!preparedDraft) {
      return;
    }
    const { content, draftSnapshot } = preparedDraft;

    if (await handleSlashCommand(content)) {
      setDraft('');
      return;
    }
    const { interrupted, submissionId: interruptedSubmissionId } = interruptedRetryId({
      store,
      bridgeProfileId,
      content,
      pendingMentionPaths,
      pendingLocalImagePaths,
      activeAgentId,
      preferredAgentId,
      preferredStartCwd,
    });

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
      bridgeProfileId,
      submissionController,
      interruptedSubmissionId,
    });

    attachmentController.beginSubmission();
    clearSubmissionComposer(draftController, submissionController, submission);
    showOptimisticChatIfNeeded({
      selectedChatIdRef,
      selectedChatRef,
      optimisticChatId,
      optimisticChat,
      preserveModelSelectionForChat,
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
      await persistPendingChatCreation({
        profileId: bridgeProfileId,
        pendingChat: optimisticChat,
        replacePendingChatId: pendingChatIdFor(interrupted),
      });
      const onCreated = createOnChatCreatedHandler({
        tracker,
        activeAgentId,
        selectedCollaborationMode,
        onLastUsedThreadSettingsChange,
        queueOptimisticUserMessage,
        optimisticMessage,
        selectedChatIdRef,
        optimisticChatId,
        preserveModelSelectionForChat,
        setSelectedChatId,
        selectedChatRef,
        setSelectedChat,
        scrollToBottomReliable,
        setActivity,
        bumpRunWatchdog,
        content,
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
        onCreated: async (created) => {
          const createdScopeKey = submissionScopeKey({
            profileId: bridgeProfileId,
            threadId: created.id,
          });
          draftController.transferScopeDraft(
            submissionScopeKey({
              profileId: bridgeProfileId,
              threadId: optimisticChatId,
            }),
            createdScopeKey,
          );
          submission.scopeKey = createdScopeKey;
          onCreated(created);
          const linked = await linkInterruptedChatCreation({
            profileId: bridgeProfileId,
            expectedPendingChatId: optimisticChatId,
            replacePendingChatId: interrupted?.pendingChatId,
            createdChat: created,
            pendingChat: optimisticChat,
          });
          if (!linked) {
            throw new Error('Unable to persist pending chat recovery.');
          }
        },
        onTurnStarted: registerTurnStarted,
      });
      const resolveUpdated = () =>
        resolveAcceptedTurnChat(
          {
            result: { chat: updated, turnId: updated.activeTurnId ?? null },
            mergeChatWithPendingOptimisticMessages,
          },
          selectedChatRef.current?.id === updated.id ? selectedChatRef.current : null,
        ) ?? updated;
      await consumeRecoveredCreation(store, bridgeProfileId, optimisticChatId, resolveUpdated());
      // Completion can arrive while the durable handoff is saving. Do not reinstall its old read.
      const resolvedUpdated = resolveUpdated();
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
      draftController.commitSubmissionClear(submission);
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
        attachmentController: attachmentControllerRef.current,
        restoreSubmission: (restored) =>
          setPendingRestoredSubmission({
            submission: restored,
            scopeKey: submissionScopeKey({
              profileId: bridgeProfileId,
              threadId: tracker.createdChatId,
            }),
          }),
        discardOptimisticUserMessage,
        optimisticMessage,
        selectedChatIdRef,
        selectedChatRef,
        optimisticChatId,
        preserveModelSelectionForChat,
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
    bridgeProfileId,
    draftController,
    activeEffort,
    activeAgentId,
    activeModelId,
    activeApprovalPolicy,
    activeServiceTier,
    handleSlashCommand,
    pendingMentionPaths,
    pendingLocalImagePaths,
    persistPendingChatCreation,
    preserveModelSelectionForChat,
    preferredStartCwd,
    selectedCollaborationMode,
    registerTurnStarted,
    handleTurnFailure,
    linkInterruptedChatCreation,
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
    store,
    submissionController,
    supportsPlanMode,
  ]);

  return {
    createChat,
  };
}

export type MainScreenChatCreationFlowResult = ReturnType<typeof useMainScreenChatCreationFlow>;
