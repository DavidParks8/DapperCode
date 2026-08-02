import type {
  BridgeUiSurface,
  Chat,
  ChatMessage as ChatTranscriptMessage,
  CollaborationMode,
  LocalImageInput,
  MentionInput,
  ReasoningEffort,
  ServiceTier,
} from '../../api/types';
import { getMessageText } from '../../api/messages';
import {
  toMentionInput,
  toOptimisticUserContent,
  normalizeChatMessageMatchContent,
  shouldAutoEnablePlanModeFromChat,
  isChatLikelyRunning,
  parseGoalSlashObjective,
  buildOptimisticGoalBridgeUiSurface,
} from './mainScreenHelpers';
import type { MainScreenSendMessageHandlerContext } from './mainScreenSendMessageHandler';
import type { ComposerSubmission } from './controllers/submissionController';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { ThreadRuntimeSnapshot } from '../../state/mainScreen/runtime';
import type { SendMessageOptions } from './mainScreenSendMessage';

export type PrepareSendMessageRequestArgs = {
  rawContent: string;
  options?: SendMessageOptions;
  selectedChatId: string | null;
};
export type BeginSendMessageSubmissionArgs = {
  rawContent: string;
  options?: SendMessageOptions;
  selectedCollaborationMode: CollaborationMode;
  selectedChat?: Chat | null;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  submissionController: MainScreenSendMessageHandlerContext['submissionController'];
  draftController: MainScreenSendMessageHandlerContext['draftController'];
};
export type GoalSurfaceStateArgs = {
  targetChatId: string;
  supportsGoal: boolean;
  content: string;
  selectedThreadSnapshot: ThreadRuntimeSnapshot | null;
  activeBridgeUiSurfaces: BridgeUiSurface[];
  replaceThreadBridgeUiSurfaces: MainScreenSendMessageHandlerContext['replaceThreadBridgeUiSurfaces'];
  selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
  setActiveBridgeUiSurfaces: (surfaces: BridgeUiSurface[]) => void;
};
export type QueuedMessageStateArgs = {
  targetChatId: string;
  content: string;
  selectedThreadSnapshot: ThreadRuntimeSnapshot | null;
  activeTurnId: string | null;
  selectedChat: Chat | null;
  pendingApproval: { requestId?: string | null } | null;
  pendingUserInputRequest: { requestId?: string | null } | null;
  queueOptimisticQueuedMessage: MainScreenSendMessageHandlerContext['queueOptimisticQueuedMessage'];
};
export type SentMessageStateArgs = {
  targetChatId: string;
  content: string;
  turnMentions: MentionInput[];
  turnLocalImages: LocalImageInput[];
  optimisticQueuedMessage: { id: string } | null;
  queueOptimisticUserMessage: MainScreenSendMessageHandlerContext['queueOptimisticUserMessage'];
  discardOptimisticUserMessage: MainScreenSendMessageHandlerContext['discardOptimisticUserMessage'];
  setSelectedChat: MainScreenSendMessageHandlerContext['setSelectedChat'];
  selectedChatState?: Chat | null;
  selectedChatRef: MainScreenSendMessageHandlerContext['selectedChatRef'];
  scrollToBottomReliable: MainScreenSendMessageHandlerContext['scrollToBottomReliable'];
};
export type OptimisticSendStateArgs = GoalSurfaceStateArgs &
  QueuedMessageStateArgs & {
    turnMentions: MentionInput[];
    turnLocalImages: LocalImageInput[];
    queueOptimisticUserMessage: MainScreenSendMessageHandlerContext['queueOptimisticUserMessage'];
    discardOptimisticUserMessage: MainScreenSendMessageHandlerContext['discardOptimisticUserMessage'];
    setSelectedChat: MainScreenSendMessageHandlerContext['setSelectedChat'];
    selectedChatState?: Chat | null;
    selectedChatRef: MainScreenSendMessageHandlerContext['selectedChatRef'];
    scrollToBottomReliable: MainScreenSendMessageHandlerContext['scrollToBottomReliable'];
  };
export type QueuedMessageResultArgs = {
  optimisticState: ReturnType<typeof createOptimisticSendState>;
  selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
  targetChatId: string;
  selectedChatRef: MainScreenSendMessageHandlerContext['selectedChatRef'];
  setActivity: (value: { tone: 'idle'; title: string }) => void;
  clearRunWatchdog: MainScreenSendMessageHandlerContext['clearRunWatchdog'];
};
export type ResolvedChatActivityArgs = {
  chat: Chat;
  autoEnabledPlan: boolean;
  resolvedCollaborationMode: CollaborationMode;
  optimisticState: ReturnType<typeof createOptimisticSendState>;
  setActivity: (value: {
    tone: 'complete' | 'error' | 'running';
    title: string;
    detail?: string;
  }) => void;
  clearRunWatchdog: MainScreenSendMessageHandlerContext['clearRunWatchdog'];
  setShowDelayedGenericRunningActivity: (value: boolean) => void;
  bumpRunWatchdog: MainScreenSendMessageHandlerContext['bumpRunWatchdog'];
};
export type StartedTurnResultArgs = {
  result: { turnId: string; chat: Chat };
  targetChatId: string;
  selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
  registerTurnStarted: MainScreenSendMessageHandlerContext['registerTurnStarted'];
  setStoppingTurn: (value: boolean) => void;
  stopRequestedRef: MainScreenSendMessageHandlerContext['stopRequestedRef'];
  shouldPreservePlan: boolean;
  setActivePlan: (value: null) => void;
  cacheThreadPlan: MainScreenSendMessageHandlerContext['cacheThreadPlan'];
  setPendingUserInputRequest: (value: null) => void;
  setUserInputDrafts: (value: Record<string, string>) => void;
  setUserInputError: (value: string | null) => void;
  setResolvingUserInput: (value: boolean) => void;
  selectedChatRef: MainScreenSendMessageHandlerContext['selectedChatRef'];
  mergeChatWithPendingOptimisticMessages: MainScreenSendMessageHandlerContext['mergeChatWithPendingOptimisticMessages'];
  suppressPlanModeAutoEnable: boolean;
  supportsPlanMode: boolean;
  setSelectedCollaborationMode: (value: CollaborationMode) => void;
  setSelectedChat: MainScreenSendMessageHandlerContext['setSelectedChat'];
  resolvedCollaborationMode: CollaborationMode;
  optimisticState: ReturnType<typeof createOptimisticSendState>;
  setActivity: (value: {
    tone: 'complete' | 'error' | 'running';
    title: string;
    detail?: string;
  }) => void;
  clearRunWatchdog: MainScreenSendMessageHandlerContext['clearRunWatchdog'];
  setShowDelayedGenericRunningActivity: (value: boolean) => void;
  bumpRunWatchdog: MainScreenSendMessageHandlerContext['bumpRunWatchdog'];
};
export type RunSendMessageTurnArgs = {
  targetChatId: string;
  content: string;
  turnMentions: MentionInput[];
  turnLocalImages: LocalImageInput[];
  selectedChat?: Chat | null;
  activeModelId: string | null;
  activeEffort: ReasoningEffort | null;
  activeServiceTier: ServiceTier | null;
  activeApprovalPolicy: MainScreenSendMessageHandlerContext['activeApprovalPolicy'];
  resolvedCollaborationMode: CollaborationMode;
  selectedEffort: ReasoningEffort | null;
  shouldClearComposer: boolean;
  shouldPreservePlan: boolean;
  submission: ComposerSubmission;
  submissionController: MainScreenSendMessageHandlerContext['submissionController'];
  draftController: MainScreenSendMessageHandlerContext['draftController'];
  setDraft: MainScreenSendMessageHandlerContext['setDraft'];
  attachmentController: MainScreenSendMessageHandlerContext['attachmentController'];
  setSending: (value: boolean) => void;
  setActivity: (value: {
    tone: 'running' | 'idle' | 'complete' | 'error';
    title: string;
    detail?: string;
  }) => void;
  bumpRunWatchdog: MainScreenSendMessageHandlerContext['bumpRunWatchdog'];
  optimisticState: ReturnType<typeof createOptimisticSendState>;
  turnExecutionController: MainScreenSendMessageHandlerContext['turnExecutionController'];
  discardOptimisticQueuedMessage: MainScreenSendMessageHandlerContext['discardOptimisticQueuedMessage'];
  cacheThreadQueueState: MainScreenSendMessageHandlerContext['cacheThreadQueueState'];
  rememberChatModelPreference: MainScreenSendMessageHandlerContext['rememberChatModelPreference'];
  clearRunWatchdog: MainScreenSendMessageHandlerContext['clearRunWatchdog'];
  selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
  setError: (value: string | null) => void;
  selectedChatRef: MainScreenSendMessageHandlerContext['selectedChatRef'];
  registerTurnStarted: MainScreenSendMessageHandlerContext['registerTurnStarted'];
  setStoppingTurn: (value: boolean) => void;
  stopRequestedRef: MainScreenSendMessageHandlerContext['stopRequestedRef'];
  setActivePlan: (value: null) => void;
  cacheThreadPlan: MainScreenSendMessageHandlerContext['cacheThreadPlan'];
  setPendingUserInputRequest: (value: null) => void;
  setUserInputDrafts: (value: Record<string, string>) => void;
  setUserInputError: (value: string | null) => void;
  setResolvingUserInput: (value: boolean) => void;
  mergeChatWithPendingOptimisticMessages: MainScreenSendMessageHandlerContext['mergeChatWithPendingOptimisticMessages'];
  supportsPlanMode: boolean;
  setSelectedCollaborationMode: (value: CollaborationMode) => void;
  setSelectedChat: MainScreenSendMessageHandlerContext['setSelectedChat'];
  setShowDelayedGenericRunningActivity: (value: boolean) => void;
  suppressPlanModeAutoEnable: boolean;
  handleTurnFailure: MainScreenSendMessageHandlerContext['handleTurnFailure'];
};

export function prepareSendMessageRequest(args: PrepareSendMessageRequestArgs) {
  const content = args.rawContent.trim();
  if (!args.selectedChatId || !content) {
    return null;
  }
  return {
    content,
    targetChatId: args.selectedChatId,
    shouldClearComposer: args.options?.clearComposer ?? true,
    shouldPreservePlan: args.options?.preservePlan ?? false,
  };
}

/**
 * Begins a composer submission. Slash commands must be handled before this runs so they never
 * consume or create a submission.
 */
export function beginSendMessageSubmission(args: BeginSendMessageSubmissionArgs) {
  const turnMentions =
    args.options?.mentions ??
    args.pendingMentionPaths.map((path) => toMentionInput(path, args.selectedChat?.cwd));
  const turnLocalImages =
    args.options?.localImages ?? args.pendingLocalImagePaths.map((path) => ({ path }));
  return {
    resolvedCollaborationMode: args.options?.collaborationMode ?? args.selectedCollaborationMode,
    turnMentions,
    turnLocalImages,
    submission:
      args.options?.submission ??
      args.submissionController.begin(
        { ...args.draftController.snapshot(), value: args.rawContent },
        {
          mentions: turnMentions.map((mention) => mention.path),
          localImages: turnLocalImages.map((image) => image.path),
        },
      ),
  };
}

export function createGoalSurfaceState(args: GoalSurfaceStateArgs) {
  const goalObjective = args.supportsGoal ? parseGoalSlashObjective(args.content) : null;
  const optimisticGoalSurface = goalObjective
    ? buildOptimisticGoalBridgeUiSurface(args.targetChatId, goalObjective, new Date().toISOString())
    : null;
  const previousBridgeUiSurfaces = optimisticGoalSurface
    ? [
        ...(args.selectedThreadSnapshot?.bridgeUiSurfaces ??
          args.activeBridgeUiSurfaces.filter((surface) => surface.threadId === args.targetChatId)),
      ]
    : null;
  const syncSurfaces = (surfaces: BridgeUiSurface[]) => {
    if (args.selectedChatIdRef.current === args.targetChatId) {
      args.setActiveBridgeUiSurfaces(surfaces);
    }
  };
  return {
    applyGoalSurface: () => {
      if (!optimisticGoalSurface) {
        return;
      }
      const nextSurfaces = [
        ...(previousBridgeUiSurfaces ?? []).filter(
          (entry) => entry.kind !== 'goal' && !entry.id.startsWith('goal-'),
        ),
        optimisticGoalSurface,
      ];
      args.replaceThreadBridgeUiSurfaces(args.targetChatId, nextSurfaces);
      syncSurfaces(nextSurfaces);
    },
    restoreGoalSurfaces: () => {
      if (!previousBridgeUiSurfaces) {
        return;
      }
      args.replaceThreadBridgeUiSurfaces(args.targetChatId, previousBridgeUiSurfaces);
      syncSurfaces(previousBridgeUiSurfaces);
    },
  };
}

const hasLocalQueueSignal = (args: QueuedMessageStateArgs) =>
  Boolean(args.activeTurnId || args.selectedThreadSnapshot?.activeTurnId) ||
  Boolean(args.selectedChat && isChatLikelyRunning(args.selectedChat));
const hasPendingInputSignal = (args: QueuedMessageStateArgs) =>
  [
    args.selectedThreadSnapshot?.pendingApproval?.requestId,
    args.pendingApproval?.requestId,
    args.selectedThreadSnapshot?.pendingUserInputRequest?.requestId,
    args.pendingUserInputRequest?.requestId,
  ].some(Boolean);

export function createQueuedMessageState(args: QueuedMessageStateArgs) {
  const knownQueuedMessages = args.selectedThreadSnapshot?.queuedMessages ?? [];
  const likelyQueuesLocally =
    knownQueuedMessages.length > 0 || hasLocalQueueSignal(args) || hasPendingInputSignal(args);
  return {
    likelyQueuesLocally,
    optimisticQueuedMessage:
      knownQueuedMessages.length === 0 && likelyQueuesLocally
        ? args.queueOptimisticQueuedMessage(args.targetChatId, args.content)
        : null,
  };
}

export function createSentMessageState(args: SentMessageStateArgs) {
  const optimisticSentContent =
    args.optimisticQueuedMessage === null
      ? toOptimisticUserContent(args.content, args.turnMentions, args.turnLocalImages)
      : null;
  const optimisticSentMessage = optimisticSentContent
    ? ({
        id: `msg-${Date.now()}`,
        role: 'user',
        content: optimisticSentContent,
        createdAt: new Date().toISOString(),
      } satisfies ChatTranscriptMessage)
    : null;
  const previousSelectedChatPreview =
    args.selectedChatRef.current?.id === args.targetChatId
      ? args.selectedChatRef.current.lastMessagePreview
      : args.selectedChatState?.id === args.targetChatId
        ? args.selectedChatState.lastMessagePreview
        : null;
  return {
    applySentMessage: () => {
      if (!optimisticSentMessage) {
        return;
      }
      args.queueOptimisticUserMessage(args.targetChatId, optimisticSentMessage);
      args.setSelectedChat((prev) => {
        const baseChat =
          args.selectedChatState?.id === args.targetChatId
            ? args.selectedChatState
            : prev?.id === args.targetChatId
              ? prev
              : prev;
        if (!baseChat) {
          return prev;
        }
        const nowIso = new Date().toISOString();
        const updated: Chat = {
          ...baseChat,
          status: 'running',
          updatedAt: nowIso,
          statusUpdatedAt: nowIso,
          lastError: undefined,
          lastMessagePreview:
            normalizeChatMessageMatchContent(optimisticSentMessage.content).slice(0, 120) ||
            baseChat.lastMessagePreview,
          messages: [...baseChat.messages, optimisticSentMessage],
        };
        args.selectedChatRef.current = updated;
        return updated;
      });
      args.scrollToBottomReliable(true);
    },
    clearSentMessage: () => {
      if (!optimisticSentMessage) {
        return;
      }
      args.discardOptimisticUserMessage(args.targetChatId, optimisticSentMessage.id);
      args.setSelectedChat((prev) => {
        if (!prev || prev.id !== args.targetChatId) {
          return prev;
        }
        const nextMessages = prev.messages.filter(
          (message) => message.id !== optimisticSentMessage.id,
        );
        if (nextMessages.length === prev.messages.length) {
          return prev;
        }
        const latestMessage = nextMessages.at(-1);
        const fallbackPreview =
          normalizeChatMessageMatchContent(
            latestMessage ? getMessageText(latestMessage) : '',
          ).slice(0, 120) || '';
        return {
          ...prev,
          lastMessagePreview:
            previousSelectedChatPreview ??
            (fallbackPreview.length > 0 ? fallbackPreview : prev.lastMessagePreview),
          messages: nextMessages,
        };
      });
    },
  };
}

export function createOptimisticSendState(args: OptimisticSendStateArgs) {
  const goal = createGoalSurfaceState(args);
  const queued = createQueuedMessageState(args);
  const sent = createSentMessageState({
    ...args,
    optimisticQueuedMessage: queued.optimisticQueuedMessage,
  });
  return {
    likelyQueuesLocally: queued.likelyQueuesLocally,
    optimisticQueuedMessage: queued.optimisticQueuedMessage,
    applyGoalSurface: goal.applyGoalSurface,
    restoreGoalSurfaces: goal.restoreGoalSurfaces,
    applySentMessage: sent.applySentMessage,
    clearSentMessage: sent.clearSentMessage,
  };
}

export function applyQueuedMessageResult(args: QueuedMessageResultArgs) {
  args.optimisticState.clearSentMessage();
  if (
    args.selectedChatIdRef.current === args.targetChatId &&
    (!args.selectedChatRef.current || !isChatLikelyRunning(args.selectedChatRef.current))
  ) {
    args.setActivity({ tone: 'idle', title: 'Message queued' });
    args.clearRunWatchdog();
  }
}

export function applyResolvedChatActivity(args: ResolvedChatActivityArgs) {
  if (args.chat.status === 'complete') {
    args.setActivity({
      tone: 'complete',
      title: 'Turn completed',
      detail:
        args.autoEnabledPlan && args.resolvedCollaborationMode !== 'plan'
          ? 'Plan mode enabled for the next turn'
          : undefined,
    });
    args.clearRunWatchdog();
  } else if (args.chat.status === 'error') {
    args.optimisticState.restoreGoalSurfaces();
    args.setActivity({
      tone: 'error',
      title: 'Turn failed',
      detail: args.chat.lastError ?? undefined,
    });
    args.clearRunWatchdog();
  } else {
    args.setShowDelayedGenericRunningActivity(true);
    args.setActivity({ tone: 'running', title: 'Working' });
    args.bumpRunWatchdog();
  }
}

export function applyStartedTurnResult(args: StartedTurnResultArgs) {
  args.registerTurnStarted(args.targetChatId, args.result.turnId);
  const isStillSelected = args.selectedChatIdRef.current === args.targetChatId;
  if (isStillSelected) {
    args.setStoppingTurn(false);
    args.stopRequestedRef.current = false;
  }
  if (!args.shouldPreservePlan) {
    if (isStillSelected) {
      args.setActivePlan(null);
    }
    args.cacheThreadPlan(args.targetChatId, null);
  }
  if (isStillSelected) {
    args.setPendingUserInputRequest(null);
    args.setUserInputDrafts({});
    args.setUserInputError(null);
    args.setResolvingUserInput(false);
  }
  const currentChat =
    args.selectedChatRef.current?.id === args.targetChatId ? args.selectedChatRef.current : null;
  const resolvedUpdated = args.mergeChatWithPendingOptimisticMessages(
    currentChat ? resolveEquivalentChat(currentChat, args.result.chat) : args.result.chat,
  );
  const autoEnabledPlan =
    !args.suppressPlanModeAutoEnable &&
    shouldAutoEnablePlanModeFromChat(resolvedUpdated, args.supportsPlanMode);
  if (autoEnabledPlan && isStillSelected) {
    args.setSelectedCollaborationMode('plan');
  }
  if (!isStillSelected) {
    return;
  }
  args.setSelectedChat(resolvedUpdated);
  applyResolvedChatActivity({
    chat: resolvedUpdated,
    autoEnabledPlan,
    resolvedCollaborationMode: args.resolvedCollaborationMode,
    optimisticState: args.optimisticState,
    setActivity: args.setActivity,
    clearRunWatchdog: args.clearRunWatchdog,
    setShowDelayedGenericRunningActivity: args.setShowDelayedGenericRunningActivity,
    bumpRunWatchdog: args.bumpRunWatchdog,
  });
}

export const finalizeSuccessfulSubmission = (
  args: Pick<
    RunSendMessageTurnArgs,
    | 'shouldClearComposer'
    | 'attachmentController'
    | 'submissionController'
    | 'submission'
    | 'setError'
  >,
  isStillSelectedForResult: boolean,
) => {
  if (args.shouldClearComposer) {
    args.attachmentController.finishSubmission(isStillSelectedForResult);
  }
  args.submissionController.succeed(args.submission);
  if (isStillSelectedForResult) {
    args.setError(null);
  }
};
export const restoreFailedSubmission = (
  args: Pick<
    RunSendMessageTurnArgs,
    | 'shouldClearComposer'
    | 'submissionController'
    | 'submission'
    | 'draftController'
    | 'attachmentController'
    | 'setDraft'
  >,
) => {
  if (!args.shouldClearComposer) {
    return;
  }
  const shouldRestoreDraft = args.submissionController.fail(
    args.submission,
    args.draftController.snapshot(),
  );
  args.attachmentController.finishSubmission(false, shouldRestoreDraft);
  if (shouldRestoreDraft) {
    args.setDraft(args.submission.draft);
  }
};
