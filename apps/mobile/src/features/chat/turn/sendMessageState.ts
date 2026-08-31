import type {
  BridgeUiSurface,
  Chat,
  ChatMessage as ChatTranscriptMessage,
  CollaborationMode,
  LocalImageInput,
  MentionInput,
  ReasoningEffort,
  ServiceTier,
} from '@bridge/types/types';
import { getMessageText } from '@bridge/messages';
import {
  toMentionInput,
  toOptimisticUserContent,
  normalizeChatMessageMatchContent,
  shouldAutoEnablePlanModeFromChat,
  isChatLikelyRunning,
  countUserMessages,
  parseGoalSlashObjective,
  buildOptimisticGoalBridgeUiSurface,
} from '../helpers/helpers';
import type { MainScreenSendMessageHandlerContext } from './sendMessageHandler';
import type { ComposerSubmission } from './controllers/submissionController';
import type { ThreadRuntimeSnapshot } from '../state/runtime';
import type { SendMessageOptions } from './sendMessage';
import {
  applyPendingAcceptedTurn,
  registerAcceptedTurn,
  resolveAcceptedTurnChat,
} from './acceptedTurnState';

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
  selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
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
    selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
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
  result: { turnId: string | null; chat: Chat | null };
  targetChatId: string;
  selectedChatIdRef: MainScreenSendMessageHandlerContext['selectedChatIdRef'];
  registerTurnStarted: MainScreenSendMessageHandlerContext['registerTurnStarted'];
  interruptLatestTurn: (threadId: string) => Promise<void>;
  setActiveTurnId: (value: string | null) => void;
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
  interruptLatestTurn: (threadId: string) => Promise<void>;
  setActiveTurnId: (value: string | null) => void;
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

const hasLiveQueueSignal = (args: QueuedMessageStateArgs) =>
  Boolean(args.activeTurnId) ||
  Boolean(args.selectedChat && isChatLikelyRunning(args.selectedChat)) ||
  [args.pendingApproval?.requestId, args.pendingUserInputRequest?.requestId].some(Boolean);
const hasCachedQueueSignal = (args: QueuedMessageStateArgs) =>
  Boolean(args.selectedThreadSnapshot?.activeTurnId);
const hasCachedPendingInputSignal = (args: QueuedMessageStateArgs) =>
  [
    args.selectedThreadSnapshot?.pendingApproval?.requestId,
    args.selectedThreadSnapshot?.pendingUserInputRequest?.requestId,
  ].some(Boolean);

export function createQueuedMessageState(args: QueuedMessageStateArgs) {
  const knownQueuedMessages = args.selectedThreadSnapshot?.queuedMessages ?? [];
  const hasLiveSignal = hasLiveQueueSignal(args);
  const likelyQueuesLocally =
    knownQueuedMessages.length > 0 ||
    hasLiveSignal ||
    hasCachedQueueSignal(args) ||
    hasCachedPendingInputSignal(args);
  return {
    likelyQueuesLocally,
    optimisticQueuedMessage:
      knownQueuedMessages.length === 0 && hasLiveSignal
        ? args.queueOptimisticQueuedMessage(args.targetChatId, args.content)
        : null,
  };
}

export function createSentMessageState(args: SentMessageStateArgs) {
  const optimisticSentContent = toOptimisticUserContent(
    args.content,
    args.turnMentions,
    args.turnLocalImages,
  );
  const optimisticSentMessage = optimisticSentContent
    ? ({
        id: `msg-${Date.now()}`,
        role: 'user',
        content: optimisticSentContent,
        createdAt: new Date().toISOString(),
      } satisfies ChatTranscriptMessage)
    : null;
  let sentMessageApplied = false;
  const previousSelectedChatPreview =
    args.selectedChatRef.current?.id === args.targetChatId
      ? args.selectedChatRef.current.lastMessagePreview
      : args.selectedChatState?.id === args.targetChatId
        ? args.selectedChatState.lastMessagePreview
        : null;
  const initialChat =
    args.selectedChatRef.current?.id === args.targetChatId
      ? args.selectedChatRef.current
      : args.selectedChatState?.id === args.targetChatId
        ? args.selectedChatState
        : null;
  const optimisticUserOrdinal = initialChat
    ? countUserMessages(initialChat.messages) + 1
    : undefined;
  const applySentMessage = () => {
    if (!optimisticSentMessage || sentMessageApplied) {
      return;
    }
    sentMessageApplied = true;
    args.queueOptimisticUserMessage(args.targetChatId, optimisticSentMessage, {
      userOrdinal: optimisticUserOrdinal,
    });
    if (args.selectedChatIdRef.current !== args.targetChatId) {
      return;
    }
    let appliedToSelectedChat = false;
    args.setSelectedChat((prev) => {
      if (!prev || prev.id !== args.targetChatId) {
        return prev;
      }
      appliedToSelectedChat = true;
      const nowIso = new Date().toISOString();
      const updated: Chat = {
        ...prev,
        status: 'running',
        updatedAt: nowIso,
        statusUpdatedAt: nowIso,
        lastError: undefined,
        lastMessagePreview:
          normalizeChatMessageMatchContent(optimisticSentMessage.content).slice(0, 120) ||
          prev.lastMessagePreview,
        messages: [...prev.messages, optimisticSentMessage],
      };
      args.selectedChatRef.current = updated;
      return updated;
    });
    if (appliedToSelectedChat) {
      args.scrollToBottomReliable(true);
    }
  };
  return {
    applySentMessage: () => {
      if (args.optimisticQueuedMessage === null) {
        applySentMessage();
      }
    },
    promoteQueuedToSentMessage: () => {
      if (args.optimisticQueuedMessage !== null) {
        applySentMessage();
      }
    },
    clearSentMessage: () => {
      if (!optimisticSentMessage || !sentMessageApplied) {
        return;
      }
      sentMessageApplied = false;
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
    promoteQueuedToSentMessage: sent.promoteQueuedToSentMessage,
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
  const isStillSelected = args.selectedChatIdRef.current === args.targetChatId;
  registerAcceptedTurn(args, isStillSelected);
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
  const resolvedChat = resolveAcceptedTurnChat(args, currentChat);
  const autoEnabledPlan =
    args.result.chat !== null &&
    resolvedChat !== null &&
    !args.suppressPlanModeAutoEnable &&
    shouldAutoEnablePlanModeFromChat(resolvedChat, args.supportsPlanMode);
  if (autoEnabledPlan && isStillSelected) {
    args.setSelectedCollaborationMode('plan');
  }
  if (!isStillSelected) {
    return;
  }
  if (applyPendingAcceptedTurn(args, resolvedChat)) {
    return;
  }
  if (!resolvedChat) {
    return;
  }
  args.setSelectedChat(resolvedChat);
  applyResolvedChatActivity({
    chat: resolvedChat,
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
