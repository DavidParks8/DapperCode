import { errorAtom, pendingApprovalAtom, pendingUserInputRequestAtom } from '../state/turn';
import { queueActionItemIdAtom, queueActionKindAtom } from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import type { BridgeQueuedMessage, Chat } from '@bridge/types/types';
import type {
  MainScreenSendMessageHandlerContext,
  MainScreenSendMessageHandlerResult,
} from '../turn/sendMessageHandler';
import { interruptedChatCreationAtom } from '@shell/state/chat/atoms';
import { interruptedCreationRetryId } from '@shell/session/interruptedChatCreation';
import type { InterruptedChatCreation } from '@shell/session/interruptedChatCreation';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { submissionScopeKey } from '../turn/controllers/submissionController';

export type MainScreenComposerSubmitActionsContext = MainScreenSendMessageHandlerContext &
  MainScreenSendMessageHandlerResult;

function linkedInterruptedSubmissionId(options: {
  interrupted: InterruptedChatCreation | null;
  threadId: string | undefined;
  content: string;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  sameProfile: boolean;
  selectedChat: Chat | null | undefined;
}): string | undefined {
  if (!options.interrupted || options.interrupted.createdChatId !== options.threadId) {
    return undefined;
  }
  return interruptedCreationRetryId(
    options.interrupted,
    options.content,
    options.pendingMentionPaths,
    options.pendingLocalImagePaths,
    options.sameProfile,
    options.selectedChat?.agentId ?? null,
    options.selectedChat?.cwd ?? null,
  );
}

function interruptedClearedDraftEntries(
  interrupted: InterruptedChatCreation | null,
  threadId: string | undefined,
  profileId: string,
): Array<{ scopeKey: string; draft: string }> | undefined {
  if (!interrupted || !threadId || interrupted.createdChatId !== threadId) {
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
  threadId: string | undefined,
): string | undefined {
  return interrupted && threadId && interrupted.createdChatId === threadId
    ? interrupted.submissionId
    : undefined;
}

export function useMainScreenComposerSubmitActions(
  context: MainScreenComposerSubmitActionsContext,
) {
  const {
    bumpRunWatchdog,
    bridgeProfileId,
    cacheThreadQueueState,
    creatingRef,
    draftController,
    handleSlashCommand,
    hasFailedAttachmentUploads,
    pendingLocalImagePaths,
    pendingMentionPaths,
    scrollToBottomReliable,
    selectedChat,
    selectedChatId,
    selectedChatIdRef,
    sendMessageContent,
    sendingRef,
    setDraft,
    stoppingTurnRef,
    submissionController,
    threadRuntimeSnapshotsRef,
    turnExecutionController,
    uploadingAttachment,
  } = context;
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const interrupted = useAtomValue(interruptedChatCreationAtom);
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const setError = useSetAtom(errorAtom);
  const queueActionItemId = useAtomValue(queueActionItemIdAtom);
  const setQueueActionItemId = useSetAtom(queueActionItemIdAtom);
  const setQueueActionKind = useSetAtom(queueActionKindAtom);

  const sendMessageContentRef = useRef(sendMessageContent);
  useEffect(() => {
    sendMessageContentRef.current = sendMessageContent;
  }, [sendMessageContent]);

  const sendMessage = useCallback(async () => {
    const draftSnapshot = draftController.snapshot();
    const content = draftSnapshot.value.trim();
    if (!content) {
      return;
    }

    if (uploadingAttachment) {
      setError('Please wait for attachments to finish uploading.');
      return;
    }

    if (hasFailedAttachmentUploads) {
      setError('Retry or remove failed attachments before sending.');
      return;
    }

    const threadId = selectedChatIdRef.current?.trim();
    const editingMessageId = threadId
      ? threadRuntimeSnapshotsRef.current[threadId]?.editingQueuedMessageId?.trim()
      : null;
    if (threadId && editingMessageId) {
      if (queueActionItemId) {
        return;
      }
      try {
        setError(null);
        setQueueActionItemId(editingMessageId);
        setQueueActionKind('editCommit');
        const response = await turnExecutionController.commitQueuedEdit(
          threadId,
          editingMessageId,
          content,
        );
        cacheThreadQueueState(threadId, response.queue);
        const currentDraft = draftController.snapshot();
        const draftIsUnchanged = [
          selectedChatIdRef.current === threadId,
          currentDraft.scopeKey === draftSnapshot.scopeKey,
          currentDraft.revision === draftSnapshot.revision,
        ].every(Boolean);
        if (draftIsUnchanged) {
          setDraft('');
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setQueueActionItemId((previous) => (previous === editingMessageId ? null : previous));
        setQueueActionKind((previous) => (previous === 'editCommit' ? null : previous));
      }
      return;
    }

    if (await handleSlashCommand(content)) {
      setDraft('');
      return;
    }

    const interruptedSubmissionId = linkedInterruptedSubmissionId({
      interrupted,
      threadId,
      content,
      pendingMentionPaths,
      pendingLocalImagePaths,
      sameProfile: activeBridgeProfileId === bridgeProfileId,
      selectedChat,
    });
    const submission = submissionController.begin(
      draftSnapshot,
      {
        mentions: pendingMentionPaths,
        localImages: pendingLocalImagePaths,
      },
      interruptedSubmissionId,
      interruptedPredecessorId(interrupted, threadId),
      interruptedClearedDraftEntries(interrupted, threadId, bridgeProfileId),
    );
    await sendMessageContent(content, { allowSlashCommands: false, submission });
  }, [
    draftController,
    cacheThreadQueueState,
    handleSlashCommand,
    sendMessageContent,
    selectedChatIdRef,
    setDraft,
    setError,
    setQueueActionItemId,
    setQueueActionKind,
    submissionController,
    threadRuntimeSnapshotsRef,
    turnExecutionController,
    pendingMentionPaths,
    pendingLocalImagePaths,
    uploadingAttachment,
    selectedChat,
    hasFailedAttachmentUploads,
    activeBridgeProfileId,
    bridgeProfileId,
    interrupted,
    queueActionItemId,
  ]);

  const handleEditQueuedMessage = useCallback(
    async (message: BridgeQueuedMessage) => {
      const threadId = selectedChatIdRef.current?.trim();
      const messageId = message.id.trim();
      if (!threadId || !messageId || queueActionItemId) {
        return;
      }
      const draftSnapshot = draftController.snapshot();
      const composerHasContent =
        uploadingAttachment ||
        hasFailedAttachmentUploads ||
        Boolean(draftSnapshot.value.trim()) ||
        pendingMentionPaths.length > 0 ||
        pendingLocalImagePaths.length > 0;
      if (composerHasContent) {
        setError('Send or clear the current draft before editing a queued message.');
        return;
      }

      try {
        setError(null);
        setQueueActionItemId(messageId);
        setQueueActionKind('editStart');
        const response = await turnExecutionController.startQueuedEdit(threadId, messageId);
        cacheThreadQueueState(threadId, response.queue);
        const currentDraft = draftController.snapshot();
        if (
          selectedChatIdRef.current === threadId &&
          currentDraft.scopeKey === draftSnapshot.scopeKey &&
          currentDraft.revision === draftSnapshot.revision
        ) {
          setDraft(message.content);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setQueueActionItemId((previous) => (previous === messageId ? null : previous));
        setQueueActionKind((previous) => (previous === 'editStart' ? null : previous));
      }
    },
    [
      cacheThreadQueueState,
      draftController,
      pendingLocalImagePaths,
      pendingMentionPaths,
      uploadingAttachment,
      hasFailedAttachmentUploads,
      queueActionItemId,
      selectedChatIdRef,
      setDraft,
      setError,
      setQueueActionItemId,
      setQueueActionKind,
      turnExecutionController,
    ],
  );

  const handleCancelQueuedMessageEdit = useCallback(async () => {
    const threadId = selectedChatIdRef.current?.trim();
    const messageId = threadId
      ? threadRuntimeSnapshotsRef.current[threadId]?.editingQueuedMessageId?.trim()
      : null;
    if (!threadId || !messageId || queueActionItemId) {
      return;
    }

    try {
      setError(null);
      setQueueActionItemId(messageId);
      setQueueActionKind('editCancel');
      const response = await turnExecutionController.cancelQueuedEdit(threadId, messageId);
      cacheThreadQueueState(threadId, response.queue);
      if (selectedChatIdRef.current === threadId) {
        setDraft('');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQueueActionItemId((previous) => (previous === messageId ? null : previous));
      setQueueActionKind((previous) => (previous === 'editCancel' ? null : previous));
    }
  }, [
    cacheThreadQueueState,
    queueActionItemId,
    selectedChatIdRef,
    setDraft,
    setError,
    setQueueActionItemId,
    setQueueActionKind,
    threadRuntimeSnapshotsRef,
    turnExecutionController,
  ]);

  const handleSteerQueuedMessage = useCallback(async () => {
    const threadId = selectedChatId?.trim();
    const queuedItems = threadId
      ? (threadRuntimeSnapshotsRef.current[threadId]?.queuedMessages ?? [])
      : [];
    const nextQueuedMessage = queuedItems[0] ?? null;
    const canSteer =
      Boolean(threadId) &&
      Boolean(nextQueuedMessage) &&
      !pendingApproval?.requestId &&
      !pendingUserInputRequest?.requestId;

    if (!threadId || !nextQueuedMessage || !canSteer) {
      return;
    }

    try {
      setError(null);
      bumpRunWatchdog();
      setQueueActionItemId(nextQueuedMessage.id);
      setQueueActionKind('steer');
      const response = await turnExecutionController.steer(threadId, nextQueuedMessage.id);
      cacheThreadQueueState(threadId, response.queue);
      scrollToBottomReliable(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQueueActionItemId((previous) => (previous === nextQueuedMessage.id ? null : previous));
      setQueueActionKind((previous) => (previous === 'steer' ? null : previous));
    }
  }, [
    turnExecutionController,
    bumpRunWatchdog,
    cacheThreadQueueState,
    pendingApproval?.requestId,
    pendingUserInputRequest?.requestId,
    scrollToBottomReliable,
    selectedChatId,
    setError,
    setQueueActionItemId,
    setQueueActionKind,
    threadRuntimeSnapshotsRef,
  ]);

  const handleCancelQueuedMessage = useCallback(
    async (messageId: string) => {
      const threadId = selectedChatId?.trim();
      const normalizedMessageId = messageId.trim();
      if (!threadId || !normalizedMessageId) {
        return;
      }

      try {
        setError(null);
        setQueueActionItemId(normalizedMessageId);
        setQueueActionKind('cancel');
        const response = await turnExecutionController.cancelQueued(threadId, normalizedMessageId);
        cacheThreadQueueState(threadId, response.queue);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setQueueActionItemId((previous) => (previous === normalizedMessageId ? null : previous));
        setQueueActionKind((previous) => (previous === 'cancel' ? null : previous));
      }
    },
    [
      cacheThreadQueueState,
      selectedChatId,
      setError,
      setQueueActionItemId,
      setQueueActionKind,
      turnExecutionController,
    ],
  );

  useEffect(() => {
    setQueueActionItemId(null);
    setQueueActionKind(null);
  }, [selectedChat?.id, setQueueActionItemId, setQueueActionKind]);

  const handleInlineOptionSelect = useCallback(
    (value: string) => {
      const option = value.trim();
      if (!option) {
        return;
      }

      const cannotAutoSend =
        !selectedChatIdRef.current ||
        sendingRef.current ||
        creatingRef.current ||
        stoppingTurnRef.current;
      if (cannotAutoSend) {
        setDraft(option);
        return;
      }

      void sendMessageContentRef.current(option, { allowSlashCommands: false });
    },
    [creatingRef, selectedChatIdRef, sendingRef, setDraft, stoppingTurnRef],
  );

  return {
    sendMessageContentRef,
    sendMessage,
    handleEditQueuedMessage,
    handleCancelQueuedMessageEdit,
    handleSteerQueuedMessage,
    handleCancelQueuedMessage,
    handleInlineOptionSelect,
  };
}

export type MainScreenComposerSubmitActionsResult = ReturnType<
  typeof useMainScreenComposerSubmitActions
>;
