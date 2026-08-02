import type { ActivityState } from '../../state/mainScreen/runtime';
import type {
  Chat,
  ChatMessage as ChatTranscriptMessage,
  CollaborationMode,
} from '../../api/types';
import { toMentionInput, toOptimisticUserContent, countUserMessages } from './mainScreenHelpers';
import type { MainScreenChatCreationFlowContext } from './mainScreenChatCreationFlow';

type TurnMention = ReturnType<typeof toMentionInput>;
type TurnLocalImage = { path: string };
type ChatSubmission = ReturnType<
  MainScreenChatCreationFlowContext['submissionController']['begin']
>;
type DraftSnapshot = ReturnType<MainScreenChatCreationFlowContext['draftController']['snapshot']>;
type DirectActivitySetter = (activity: ActivityState) => void;
export type OptimisticChatSetup = {
  content: string;
  submission: ChatSubmission;
  turnMentions: TurnMention[];
  turnLocalImages: TurnLocalImage[];
  optimisticMessage: ChatTranscriptMessage;
  optimisticChatId: string;
  optimisticChat: Chat;
};
export type ChatCreationVisibilityTracker = {
  adoptedCreatedChat: boolean;
  createdChatId: string | null;
  isVisible: () => boolean;
  markAdopted: () => void;
  markCreated: (chatId: string) => void;
};

export function buildOptimisticChatSetup(params: {
  draftSnapshot: DraftSnapshot;
  content: string;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  preferredStartCwd: string | null;
  activeAgentId: string | null;
  preferredAgentId: string | null;
  submissionController: MainScreenChatCreationFlowContext['submissionController'];
}): OptimisticChatSetup {
  const {
    draftSnapshot,
    content,
    pendingMentionPaths,
    pendingLocalImagePaths,
    preferredStartCwd,
    activeAgentId,
    preferredAgentId,
    submissionController,
  } = params;
  const turnMentions = pendingMentionPaths.map((path) => toMentionInput(path, preferredStartCwd));
  const turnLocalImages = pendingLocalImagePaths.map((path) => ({ path }));
  const submission = submissionController.begin(draftSnapshot, {
    mentions: pendingMentionPaths,
    localImages: pendingLocalImagePaths,
  });
  const optimisticMessage: ChatTranscriptMessage = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content: toOptimisticUserContent(content, turnMentions, turnLocalImages),
    createdAt: new Date().toISOString(),
  };
  const optimisticChatId = `pending-${submission.id}`;
  const optimisticCreatedAt = new Date().toISOString();
  return {
    content,
    submission,
    turnMentions,
    turnLocalImages,
    optimisticMessage,
    optimisticChatId,
    optimisticChat: {
      id: optimisticChatId,
      title: '',
      status: 'running',
      activeTurnId: null,
      createdAt: optimisticCreatedAt,
      updatedAt: optimisticCreatedAt,
      statusUpdatedAt: optimisticCreatedAt,
      lastMessagePreview: content.slice(0, 50),
      cwd: preferredStartCwd ?? '',
      agentId: activeAgentId ?? preferredAgentId ?? 'unknown',
      messages: [optimisticMessage],
    },
  };
}

export function showOptimisticChatIfNeeded(params: {
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'];
  selectedChatRef: MainScreenChatCreationFlowContext['selectedChatRef'];
  optimisticChatId: string;
  optimisticChat: Chat;
  setSelectedChatId: MainScreenChatCreationFlowContext['setSelectedChatId'];
  setSelectedChat: MainScreenChatCreationFlowContext['setSelectedChat'];
  scrollToBottomReliable: MainScreenChatCreationFlowContext['scrollToBottomReliable'];
}): void {
  const {
    selectedChatIdRef,
    selectedChatRef,
    optimisticChatId,
    optimisticChat,
    setSelectedChatId,
    setSelectedChat,
    scrollToBottomReliable,
  } = params;
  if (selectedChatIdRef.current !== null) {
    return;
  }

  selectedChatIdRef.current = optimisticChatId;
  selectedChatRef.current = optimisticChat;
  setSelectedChatId(optimisticChatId);
  setSelectedChat(optimisticChat);
  scrollToBottomReliable(true);
}

export function createChatVisibilityTracker(
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'],
  optimisticChatId: string,
): ChatCreationVisibilityTracker {
  return {
    createdChatId: null,
    adoptedCreatedChat: false,
    markCreated(chatId) {
      this.createdChatId = chatId;
    },
    markAdopted() {
      this.adoptedCreatedChat = true;
    },
    isVisible() {
      return this.createdChatId
        ? selectedChatIdRef.current === this.createdChatId ||
            (this.adoptedCreatedChat && selectedChatIdRef.current === null)
        : selectedChatIdRef.current === null || selectedChatIdRef.current === optimisticChatId;
    },
  };
}

export function resetChatCreationUi(params: {
  setCreating: (creating: boolean) => void;
  setActiveTurnId: (turnId: string | null) => void;
  setStoppingTurn: (stopping: boolean) => void;
  stopRequestedRef: MainScreenChatCreationFlowContext['stopRequestedRef'];
  setActivePlan: (value: null) => void;
  setPendingUserInputRequest: (value: null) => void;
  setUserInputDrafts: (value: Record<string, string>) => void;
  setUserInputError: (value: null) => void;
  setResolvingUserInput: (value: boolean) => void;
  setActivity: (activity: { tone: 'running'; title: 'Creating chat' }) => void;
}): void {
  params.setCreating(true);
  params.setActiveTurnId(null);
  params.setStoppingTurn(false);
  params.stopRequestedRef.current = false;
  params.setActivePlan(null);
  params.setPendingUserInputRequest(null);
  params.setUserInputDrafts({});
  params.setUserInputError(null);
  params.setResolvingUserInput(false);
  params.setActivity({
    tone: 'running',
    title: 'Creating chat',
  });
}

export function shouldAdoptCreatedChatSelection(
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'],
  optimisticChatId: string,
): boolean {
  return selectedChatIdRef.current === null || selectedChatIdRef.current === optimisticChatId;
}

export function buildVisibleCreatedChat(
  created: Chat,
  content: string,
  optimisticMessage: ChatTranscriptMessage,
): Chat {
  return {
    ...created,
    status: 'running',
    updatedAt: new Date().toISOString(),
    statusUpdatedAt: new Date().toISOString(),
    lastMessagePreview: content.slice(0, 50),
    messages:
      countUserMessages(created.messages) > 0
        ? created.messages
        : [...created.messages, optimisticMessage],
  };
}

export function createOnChatCreatedHandler(params: {
  tracker: ChatCreationVisibilityTracker;
  activeAgentId: string | null;
  selectedCollaborationMode: CollaborationMode;
  onLastUsedThreadSettingsChange: MainScreenChatCreationFlowContext['onLastUsedThreadSettingsChange'];
  queueOptimisticUserMessage: MainScreenChatCreationFlowContext['queueOptimisticUserMessage'];
  optimisticMessage: ChatTranscriptMessage;
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'];
  optimisticChatId: string;
  setSelectedChatId: MainScreenChatCreationFlowContext['setSelectedChatId'];
  selectedChatRef: MainScreenChatCreationFlowContext['selectedChatRef'];
  setSelectedChat: MainScreenChatCreationFlowContext['setSelectedChat'];
  scrollToBottomReliable: MainScreenChatCreationFlowContext['scrollToBottomReliable'];
  setActivity: DirectActivitySetter;
  bumpRunWatchdog: MainScreenChatCreationFlowContext['bumpRunWatchdog'];
  content: string;
}) {
  const {
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
  } = params;

  return (created: Chat) => {
    tracker.markCreated(created.id);
    if (activeAgentId) {
      onLastUsedThreadSettingsChange?.(activeAgentId, selectedCollaborationMode);
    }
    queueOptimisticUserMessage(created.id, optimisticMessage, {
      baseChat: created,
      userOrdinal: 1,
    });
    if (!shouldAdoptCreatedChatSelection(selectedChatIdRef, optimisticChatId)) {
      return;
    }

    tracker.markAdopted();
    selectedChatIdRef.current = created.id;
    setSelectedChatId(created.id);
    const visibleCreatedChat = buildVisibleCreatedChat(created, content, optimisticMessage);
    selectedChatRef.current = visibleCreatedChat;
    setSelectedChat(visibleCreatedChat);
    scrollToBottomReliable(true);
    setActivity({ tone: 'running', title: 'Working' });
    bumpRunWatchdog();
  };
}

export function updateCreatedChatActivity(params: {
  resolvedUpdated: Chat;
  autoEnabledPlan: boolean;
  selectedCollaborationMode: CollaborationMode;
  setActivity: DirectActivitySetter;
  clearRunWatchdog: MainScreenChatCreationFlowContext['clearRunWatchdog'];
  bumpRunWatchdog: MainScreenChatCreationFlowContext['bumpRunWatchdog'];
}): void {
  const {
    resolvedUpdated,
    autoEnabledPlan,
    selectedCollaborationMode,
    setActivity,
    clearRunWatchdog,
    bumpRunWatchdog,
  } = params;
  if (resolvedUpdated.status === 'complete') {
    setActivity({
      tone: 'complete',
      title: 'Turn completed',
      detail:
        autoEnabledPlan && selectedCollaborationMode !== 'plan'
          ? 'Plan mode enabled for the next turn'
          : undefined,
    });
    clearRunWatchdog();
    return;
  }

  if (resolvedUpdated.status === 'error') {
    setActivity({
      tone: 'error',
      title: 'Turn failed',
      detail: resolvedUpdated.lastError ?? undefined,
    });
    clearRunWatchdog();
    return;
  }

  setActivity({
    tone: 'running',
    title: 'Working',
  });
  bumpRunWatchdog();
}

export function clearOptimisticChatSelection(params: {
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'];
  selectedChatRef: MainScreenChatCreationFlowContext['selectedChatRef'];
  optimisticChatId: string;
  setSelectedChatId: MainScreenChatCreationFlowContext['setSelectedChatId'];
  setSelectedChat: MainScreenChatCreationFlowContext['setSelectedChat'];
}): void {
  const {
    selectedChatIdRef,
    selectedChatRef,
    optimisticChatId,
    setSelectedChatId,
    setSelectedChat,
  } = params;
  if (selectedChatIdRef.current !== optimisticChatId) {
    return;
  }

  selectedChatIdRef.current = null;
  selectedChatRef.current = null;
  setSelectedChatId(null);
  setSelectedChat(null);
}

export function shouldRestoreDraftForCreateFailure(params: {
  tracker: ChatCreationVisibilityTracker;
  submissionController: MainScreenChatCreationFlowContext['submissionController'];
  submission: ChatSubmission;
  currentDraft: DraftSnapshot;
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'];
}): boolean {
  const { tracker, submissionController, submission, currentDraft, selectedChatIdRef } = params;
  if (!tracker.createdChatId) {
    return true;
  }

  if (submissionController.fail(submission, currentDraft)) {
    return true;
  }

  return Boolean(
    tracker.createdChatId &&
    tracker.adoptedCreatedChat &&
    selectedChatIdRef.current === tracker.createdChatId &&
    currentDraft.value === '',
  );
}

export function handleCreateChatFailure(params: {
  draftController: MainScreenChatCreationFlowContext['draftController'];
  submissionController: MainScreenChatCreationFlowContext['submissionController'];
  submission: ChatSubmission;
  tracker: ChatCreationVisibilityTracker;
  attachmentController: MainScreenChatCreationFlowContext['attachmentController'];
  pendingRestoredDraftRef: { current: string | null };
  setDraft: MainScreenChatCreationFlowContext['setDraft'];
  discardOptimisticUserMessage: MainScreenChatCreationFlowContext['discardOptimisticUserMessage'];
  optimisticMessage: ChatTranscriptMessage;
  selectedChatIdRef: MainScreenChatCreationFlowContext['selectedChatIdRef'];
  selectedChatRef: MainScreenChatCreationFlowContext['selectedChatRef'];
  optimisticChatId: string;
  setSelectedChatId: MainScreenChatCreationFlowContext['setSelectedChatId'];
  setSelectedChat: MainScreenChatCreationFlowContext['setSelectedChat'];
  handleTurnFailure: MainScreenChatCreationFlowContext['handleTurnFailure'];
  error: unknown;
}): void {
  const currentDraft = params.draftController.snapshot();
  const shouldRestoreDraft = shouldRestoreDraftForCreateFailure({
    tracker: params.tracker,
    submissionController: params.submissionController,
    submission: params.submission,
    currentDraft,
    selectedChatIdRef: params.selectedChatIdRef,
  });
  params.attachmentController.finishSubmission(false, shouldRestoreDraft);
  if (shouldRestoreDraft) {
    params.pendingRestoredDraftRef.current = params.submission.draft;
    params.setDraft(params.submission.draft);
  }
  if (params.tracker.createdChatId) {
    params.discardOptimisticUserMessage(params.tracker.createdChatId, params.optimisticMessage.id);
  }
  if (!params.tracker.createdChatId) {
    clearOptimisticChatSelection({
      selectedChatIdRef: params.selectedChatIdRef,
      selectedChatRef: params.selectedChatRef,
      optimisticChatId: params.optimisticChatId,
      setSelectedChatId: params.setSelectedChatId,
      setSelectedChat: params.setSelectedChat,
    });
  }
  if (params.tracker.isVisible()) {
    params.handleTurnFailure(params.error);
  }
}
