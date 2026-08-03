import {
  activeBridgeUiSurfacesAtom,
  activePlanAtom,
  creatingAtom,
  errorAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  sendingAtom,
  stoppingTurnAtom,
  userInputErrorAtom,
} from '../state/turn';
import { selectedCollaborationModeAtom } from '../state/models';
import {
  composerHeightAtom,
  keyboardInsetAtom,
  keyboardVisibleAtom,
  pendingPlanImplementationPromptsAtom,
  planPanelCollapsedByThreadAtom,
  queueActionItemIdAtom,
  queueActionKindAtom,
} from '../state/composer';
import { useAtomValue } from 'jotai';
import type { BridgeUiSurface, Chat, ChatSummary } from '@bridge/types/types';
import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { isSettledIdleActivity } from '../screen/activityIndicator';
import { hasStructuredPlanCardContent, resolveWorkflowCardMode } from '../plan/cardState';
import {
  type ActivePlanState,
  type PendingOptimisticQueuedMessage,
  type ThreadRuntimeSnapshot,
  canOfferQueuedMessageSteer,
  isBridgeConnectionErrorMessage,
  resolveDisplayedThreadPlan,
  resolvePersistedPlanImplementationPrompt,
  resolveUndismissedPlanImplementationPrompt,
  toPersistedActivePlanState,
} from '../helpers/helpers';
import type {
  MainScreenHeaderActivityViewModelContext,
  MainScreenHeaderActivityViewModelResult,
} from '../screen/headerActivityViewModel';
import { gitCheckoutErrorAtom } from '../../workspace/state/gitCheckout';
import {
  collaborationModeMenuVisibleAtom,
  effortModalVisibleAtom,
  modelModalVisibleAtom,
} from '../state/modals';

export type MainScreenWorkflowQueueStateContext = MainScreenHeaderActivityViewModelContext &
  MainScreenHeaderActivityViewModelResult;

function resolveSelectedThreadRuntimeSnapshot(
  selectedChat: ChatSummary | null,
  threadRuntimeSnapshotsRef: MainScreenWorkflowQueueStateContext['threadRuntimeSnapshotsRef'],
): ThreadRuntimeSnapshot | null {
  if (!selectedChat) {
    return null;
  }
  return threadRuntimeSnapshotsRef.current[selectedChat.id] ?? null;
}

function resolveBridgeUiSurfaceBuckets(
  selectedChat: ChatSummary | null,
  activeBridgeUiSurfaces: BridgeUiSurface[],
) {
  const buckets = {
    selectedBridgeUiSurfaces: [] as BridgeUiSurface[],
    workflowBridgeUiSurfaces: [] as BridgeUiSurface[],
    bannerBridgeUiSurfaces: [] as BridgeUiSurface[],
    modalBridgeUiSurface: null as BridgeUiSurface | null,
  };
  if (!selectedChat) {
    return buckets;
  }

  for (const surface of activeBridgeUiSurfaces) {
    if (surface.threadId !== selectedChat.id) {
      continue;
    }
    buckets.selectedBridgeUiSurfaces.push(surface);
    if (surface.presentation === 'workflowCard') {
      buckets.workflowBridgeUiSurfaces.push(surface);
      continue;
    }
    if (surface.presentation === 'banner') {
      buckets.bannerBridgeUiSurfaces.push(surface);
      continue;
    }
    if (surface.presentation === 'modal' && buckets.modalBridgeUiSurface === null) {
      buckets.modalBridgeUiSurface = surface;
    }
  }

  return buckets;
}

function resolveQueuedMessageSteerDisabledReason(options: {
  showingOptimisticQueuedMessage: boolean;
  selectedQueueError: ThreadRuntimeSnapshot['queuedMessageError'] | null;
  queueActionKind: string | null;
  activeAgentSupports: MainScreenWorkflowQueueStateContext['activeAgentSupports'];
}): string | null {
  if (options.showingOptimisticQueuedMessage) {
    return 'Sending the queued message to the bridge.';
  }
  if (options.selectedQueueError?.message) {
    return options.selectedQueueError.message;
  }
  if (options.queueActionKind === 'steer') {
    return 'Sending the queued message to the current turn.';
  }
  if (options.queueActionKind === 'cancel') {
    return 'Removing the queued message.';
  }
  if (options.activeAgentSupports?.turnSteer !== true) {
    return 'The active agent does not support steering.';
  }
  return null;
}

function resolveSelectedOptimisticQueuedMessages(
  selectedChat: ChatSummary | null,
  pendingOptimisticQueuedMessagesRef: MainScreenWorkflowQueueStateContext['pendingOptimisticQueuedMessagesRef'],
): PendingOptimisticQueuedMessage[] {
  if (!selectedChat) {
    return [];
  }
  return pendingOptimisticQueuedMessagesRef.current[selectedChat.id] ?? [];
}

function resolveSelectedQueuedMessages(
  selectedBridgeQueuedMessages: NonNullable<ThreadRuntimeSnapshot['queuedMessages']>,
  selectedOptimisticQueuedMessages: PendingOptimisticQueuedMessage[],
) {
  const showingOptimisticQueuedMessage =
    selectedBridgeQueuedMessages.length === 0 && selectedOptimisticQueuedMessages.length > 0;
  return {
    showingOptimisticQueuedMessage,
    selectedQueuedMessages: showingOptimisticQueuedMessage
      ? selectedOptimisticQueuedMessages
      : selectedBridgeQueuedMessages,
  };
}

function resolveOldestQueuedMessageIsPendingSteer(
  selectedThreadRuntimeSnapshot: ThreadRuntimeSnapshot | null,
  oldestQueuedMessage: { id: string } | null,
): boolean {
  return Boolean(
    oldestQueuedMessage &&
    selectedThreadRuntimeSnapshot?.pendingSteerMessageIds?.includes(oldestQueuedMessage.id),
  );
}

function resolveCanCancelQueuedMessage(
  oldestQueuedMessage: { id: string } | null,
  showingOptimisticQueuedMessage: boolean,
  queueActionInFlight: boolean,
  selectedThreadRuntimeSnapshot: ThreadRuntimeSnapshot | null,
): boolean {
  return (
    Boolean(oldestQueuedMessage) &&
    !showingOptimisticQueuedMessage &&
    !queueActionInFlight &&
    selectedThreadRuntimeSnapshot?.steeringInFlight !== true
  );
}

function resolveQueuedMessageState(options: {
  selectedChat: ChatSummary | null;
  selectedChatId: string | null;
  selectedThreadRuntimeSnapshot: ThreadRuntimeSnapshot | null;
  pendingOptimisticQueuedMessagesRef: MainScreenWorkflowQueueStateContext['pendingOptimisticQueuedMessagesRef'];
  activeAgentSupports: MainScreenWorkflowQueueStateContext['activeAgentSupports'];
  queueActionItemId: string | null;
  queueActionKind: string | null;
}) {
  const selectedBridgeQueuedMessages = options.selectedThreadRuntimeSnapshot?.queuedMessages ?? [];
  const selectedOptimisticQueuedMessages = resolveSelectedOptimisticQueuedMessages(
    options.selectedChat,
    options.pendingOptimisticQueuedMessagesRef,
  );
  const { showingOptimisticQueuedMessage, selectedQueuedMessages } = resolveSelectedQueuedMessages(
    selectedBridgeQueuedMessages,
    selectedOptimisticQueuedMessages,
  );
  const selectedQueueError = options.selectedThreadRuntimeSnapshot?.queuedMessageError ?? null;
  const oldestQueuedMessage = selectedQueuedMessages[0] ?? null;
  const oldestQueuedMessageIsPendingSteer = resolveOldestQueuedMessageIsPendingSteer(
    options.selectedThreadRuntimeSnapshot,
    oldestQueuedMessage,
  );
  const remainingQueuedMessagesCount = Math.max(0, selectedQueuedMessages.length - 1);
  const queueActionInFlight = Boolean(options.queueActionItemId);
  const canSteerQueuedMessage = canOfferQueuedMessageSteer({
    hasQueuedMessage: Boolean(oldestQueuedMessage),
    hasSelectedThread: Boolean(options.selectedChatId),
    supportsSteer: options.activeAgentSupports?.turnSteer === true,
    isPendingSteer: oldestQueuedMessageIsPendingSteer,
    isOptimistic: showingOptimisticQueuedMessage,
    actionInFlight: queueActionInFlight,
  });
  const canCancelQueuedMessage = resolveCanCancelQueuedMessage(
    oldestQueuedMessage,
    showingOptimisticQueuedMessage,
    queueActionInFlight,
    options.selectedThreadRuntimeSnapshot,
  );

  return {
    selectedBridgeQueuedMessages,
    selectedOptimisticQueuedMessages,
    showingOptimisticQueuedMessage,
    selectedQueuedMessages,
    selectedQueueError,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    remainingQueuedMessagesCount,
    queueActionInFlight,
    canSteerQueuedMessage,
    canCancelQueuedMessage,
    queuedMessageSteerDisabledReason: resolveQueuedMessageSteerDisabledReason({
      showingOptimisticQueuedMessage,
      selectedQueueError,
      queueActionKind: options.queueActionKind,
      activeAgentSupports: options.activeAgentSupports,
    }),
  };
}

function resolvePlanState(options: {
  selectedChat: Chat | null;
  activePlan: ActivePlanState | null;
  selectedThreadRuntimeSnapshot: ThreadRuntimeSnapshot | null;
  chatPlanSnapshotsRef: MainScreenWorkflowQueueStateContext['chatPlanSnapshotsRef'];
  dismissedPlanImplementationTurnIdByThreadRef: MainScreenWorkflowQueueStateContext['dismissedPlanImplementationTurnIdByThreadRef'];
  pendingPlanImplementationPrompts: Record<string, { threadId: string; turnId: string } | null>;
  planPanelCollapsedByThread: Record<string, boolean | undefined>;
}) {
  const emptyState = {
    inMemorySelectedThreadPlan: null as ActivePlanState | null,
    persistedSelectedThreadPlan: null as ActivePlanState | null,
    selectedThreadPlan: null as ActivePlanState | null,
    dismissedSelectedPlanTurnId: null as string | null,
    derivedSelectedPlanImplementationPrompt: null as { threadId: string; turnId: string } | null,
    selectedPlanImplementationPrompt: null as { threadId: string; turnId: string } | null,
    planPanelCollapsed: false,
  };
  if (!options.selectedChat) {
    return emptyState;
  }

  const inMemorySelectedThreadPlan =
    options.activePlan?.threadId === options.selectedChat.id
      ? options.activePlan
      : (options.selectedThreadRuntimeSnapshot?.plan ??
        options.chatPlanSnapshotsRef.current[options.selectedChat.id] ??
        null);
  const persistedSelectedThreadPlan = toPersistedActivePlanState(
    options.selectedChat.latestPlan,
    options.selectedChat.updatedAt,
  );
  const selectedThreadPlan = resolveDisplayedThreadPlan(
    inMemorySelectedThreadPlan,
    persistedSelectedThreadPlan,
    options.selectedThreadRuntimeSnapshot,
  );
  const dismissedSelectedPlanTurnId =
    options.dismissedPlanImplementationTurnIdByThreadRef.current[options.selectedChat.id] ?? null;
  const derivedSelectedPlanImplementationPrompt = resolvePersistedPlanImplementationPrompt(
    options.selectedChat,
    dismissedSelectedPlanTurnId,
  );
  const selectedPlanImplementationPrompt =
    resolveUndismissedPlanImplementationPrompt(
      options.pendingPlanImplementationPrompts[options.selectedChat.id] ?? null,
      dismissedSelectedPlanTurnId,
    ) ?? derivedSelectedPlanImplementationPrompt;

  return {
    inMemorySelectedThreadPlan,
    persistedSelectedThreadPlan,
    selectedThreadPlan,
    dismissedSelectedPlanTurnId,
    derivedSelectedPlanImplementationPrompt,
    selectedPlanImplementationPrompt,
    planPanelCollapsed: options.planPanelCollapsedByThread[options.selectedChat.id] ?? false,
  };
}

function resolveShowPlanImplementationPrompt(options: {
  selectedPlanImplementationPrompt: { threadId: string; turnId: string } | null;
  activeAgentSupports: MainScreenWorkflowQueueStateContext['activeAgentSupports'];
  isOpeningChat: boolean;
  sending: boolean;
  creating: boolean;
  stoppingTurn: boolean;
  pendingApproval: unknown;
  pendingUserInputRequest: unknown;
  attachmentMenuVisible: boolean;
  attachmentModalVisible: boolean;
  collaborationModeMenuVisible: boolean;
  modelModalVisible: boolean;
  effortModalVisible: boolean;
  selectedQueuedMessages: Array<{ id: string } | PendingOptimisticQueuedMessage>;
}): boolean {
  return (
    Boolean(options.selectedPlanImplementationPrompt) &&
    options.activeAgentSupports?.planMode === true &&
    !options.isOpeningChat &&
    !options.sending &&
    !options.creating &&
    !options.stoppingTurn &&
    !options.pendingApproval &&
    !options.pendingUserInputRequest &&
    !options.attachmentMenuVisible &&
    !options.attachmentModalVisible &&
    !options.collaborationModeMenuVisible &&
    !options.modelModalVisible &&
    !options.effortModalVisible &&
    options.selectedQueuedMessages.length === 0
  );
}

function resolveComposerInsets(options: {
  shouldShowComposer: boolean;
  theme: MainScreenWorkflowQueueStateContext['theme'];
  safeAreaInsets: MainScreenWorkflowQueueStateContext['safeAreaInsets'];
  keyboardVisible: boolean;
  keyboardInset: number;
  composerHeight: number;
}) {
  const chatBottomInset = options.shouldShowComposer
    ? options.theme.spacing.lg
    : Math.max(options.theme.spacing.xxl, options.safeAreaInsets.bottom + options.theme.spacing.lg);
  const composerSafeAreaBottomInset = options.safeAreaInsets.bottom;
  const composerOverlayInset = options.keyboardVisible ? options.keyboardInset : 0;
  const composerReservedInset = options.shouldShowComposer
    ? Math.max(
        options.theme.spacing.lg,
        options.composerHeight + composerOverlayInset + options.theme.spacing.sm,
      )
    : chatBottomInset;

  return {
    composerSafeAreaBottomInset,
    composerOverlayInset,
    composerReservedInset,
  };
}

function resolveVisibleError(connected: boolean, error: string | null): string | null {
  if (!connected && isBridgeConnectionErrorMessage(error)) {
    return null;
  }
  return error;
}

export function useMainScreenWorkflowQueueState(context: MainScreenWorkflowQueueStateContext) {
  const {
    activeAgentSupports,
    attachmentMenuVisible,
    attachmentModalVisible,
    chatPlanSnapshotsRef,
    dismissedPlanImplementationTurnIdByThreadRef,
    displayedActivity,
    draft,
    isOpeningChat,
    pendingOptimisticQueuedMessagesRef,
    safeAreaInsets,
    selectedChat,
    selectedChatId,
    shouldShowComposer,
    showBridgeRecoveryBanner,
    slashSuggestions,
    theme,
    threadRuntimeSnapshotsRef,
    ws,
  } = context;
  const sending = useAtomValue(sendingAtom);
  const creating = useAtomValue(creatingAtom);
  const error = useAtomValue(errorAtom);
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const userInputError = useAtomValue(userInputErrorAtom);
  const activePlan = useAtomValue(activePlanAtom);
  const activeBridgeUiSurfaces = useAtomValue(activeBridgeUiSurfacesAtom);
  const stoppingTurn = useAtomValue(stoppingTurnAtom);
  const selectedCollaborationMode = useAtomValue(selectedCollaborationModeAtom);
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  const keyboardInset = useAtomValue(keyboardInsetAtom);
  const composerHeight = useAtomValue(composerHeightAtom);
  const queueActionItemId = useAtomValue(queueActionItemIdAtom);
  const queueActionKind = useAtomValue(queueActionKindAtom);
  const planPanelCollapsedByThread = useAtomValue(planPanelCollapsedByThreadAtom);
  const pendingPlanImplementationPrompts = useAtomValue(pendingPlanImplementationPromptsAtom);
  const modelModalVisible = useAtomValue(modelModalVisibleAtom);
  const collaborationModeMenuVisible = useAtomValue(collaborationModeMenuVisibleAtom);
  const effortModalVisible = useAtomValue(effortModalVisibleAtom);
  const gitCheckoutError = useAtomValue(gitCheckoutErrorAtom);

  const selectedThreadRuntimeSnapshot = resolveSelectedThreadRuntimeSnapshot(
    selectedChat,
    threadRuntimeSnapshotsRef,
  );
  const {
    selectedBridgeUiSurfaces,
    workflowBridgeUiSurfaces,
    bannerBridgeUiSurfaces,
    modalBridgeUiSurface,
  } = resolveBridgeUiSurfaceBuckets(selectedChat, activeBridgeUiSurfaces);
  const {
    selectedBridgeQueuedMessages,
    selectedOptimisticQueuedMessages,
    showingOptimisticQueuedMessage,
    selectedQueuedMessages,
    selectedQueueError,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    remainingQueuedMessagesCount,
    queueActionInFlight,
    canSteerQueuedMessage,
    canCancelQueuedMessage,
    queuedMessageSteerDisabledReason,
  } = resolveQueuedMessageState({
    selectedChat,
    selectedChatId,
    selectedThreadRuntimeSnapshot,
    pendingOptimisticQueuedMessagesRef,
    activeAgentSupports,
    queueActionItemId,
    queueActionKind,
  });
  const {
    inMemorySelectedThreadPlan,
    persistedSelectedThreadPlan,
    selectedThreadPlan,
    dismissedSelectedPlanTurnId,
    derivedSelectedPlanImplementationPrompt,
    selectedPlanImplementationPrompt,
    planPanelCollapsed,
  } = resolvePlanState({
    selectedChat,
    activePlan,
    selectedThreadRuntimeSnapshot,
    chatPlanSnapshotsRef,
    dismissedPlanImplementationTurnIdByThreadRef,
    pendingPlanImplementationPrompts,
    planPanelCollapsedByThread,
  });
  const showStructuredPlanCard = hasStructuredPlanCardContent(selectedThreadPlan);
  const fastModeControlDisabled = isOpeningChat;
  const showSlashSuggestions = slashSuggestions.length > 0 && draft.trimStart().startsWith('/');
  const showQueuedMessageDock =
    Boolean(selectedChat) && !isOpeningChat && Boolean(oldestQueuedMessage);
  const showPlanImplementationPrompt = resolveShowPlanImplementationPrompt({
    selectedPlanImplementationPrompt,
    activeAgentSupports,
    isOpeningChat,
    sending,
    creating,
    stoppingTurn,
    pendingApproval,
    pendingUserInputRequest,
    attachmentMenuVisible,
    attachmentModalVisible,
    collaborationModeMenuVisible,
    modelModalVisible,
    effortModalVisible,
    selectedQueuedMessages,
  });
  const workflowCardMode = resolveWorkflowCardMode({
    collaborationMode: selectedCollaborationMode,
    hasStructuredPlan: showStructuredPlanCard,
    hasPlanApprovalPrompt: showPlanImplementationPrompt,
  });
  const showTopCardsRow =
    !isOpeningChat && (workflowCardMode !== null || workflowBridgeUiSurfaces.length > 0);
  const showFloatingActivity =
    shouldShowComposer &&
    Boolean(selectedChat) &&
    !isOpeningChat &&
    !showBridgeRecoveryBanner &&
    !isSettledIdleActivity(displayedActivity);
  const { composerSafeAreaBottomInset, composerOverlayInset, composerReservedInset } =
    resolveComposerInsets({
      shouldShowComposer,
      theme,
      safeAreaInsets,
      keyboardVisible,
      keyboardInset,
      composerHeight,
    });
  const visibleError = resolveVisibleError(ws.isConnected, error);

  useAccessibilityAnnouncement(visibleError ?? userInputError ?? gitCheckoutError);

  return {
    selectedThreadRuntimeSnapshot,
    selectedBridgeUiSurfaces,
    workflowBridgeUiSurfaces,
    bannerBridgeUiSurfaces,
    modalBridgeUiSurface,
    selectedBridgeQueuedMessages,
    selectedOptimisticQueuedMessages,
    showingOptimisticQueuedMessage,
    selectedQueuedMessages,
    selectedQueueError,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    remainingQueuedMessagesCount,
    queueActionInFlight,
    inMemorySelectedThreadPlan,
    persistedSelectedThreadPlan,
    selectedThreadPlan,
    dismissedSelectedPlanTurnId,
    derivedSelectedPlanImplementationPrompt,
    selectedPlanImplementationPrompt,
    showStructuredPlanCard,
    planPanelCollapsed,
    fastModeControlDisabled,
    showSlashSuggestions,
    canSteerQueuedMessage,
    canCancelQueuedMessage,
    queuedMessageSteerDisabledReason,
    showQueuedMessageDock,
    showPlanImplementationPrompt,
    workflowCardMode,
    showTopCardsRow,
    showFloatingActivity,
    composerSafeAreaBottomInset,
    composerOverlayInset,
    visibleError,
    composerReservedInset,
  };
}

export type MainScreenWorkflowQueueStateResult = ReturnType<typeof useMainScreenWorkflowQueueState>;
