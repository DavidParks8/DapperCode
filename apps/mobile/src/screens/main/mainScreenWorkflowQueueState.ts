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
} from '../../state/mainScreen/turn';
import { selectedCollaborationModeAtom } from '../../state/mainScreen/models';
import {
  agentDetailThreadIdAtom,
  agentRootThreadIdAtom,
  relatedAgentThreadsAtom,
} from '../../state/mainScreen/workspace';
import {
  androidKeyboardInsetAtom,
  composerHeightAtom,
  keyboardVisibleAtom,
  pendingPlanImplementationPromptsAtom,
  planPanelCollapsedByThreadAtom,
  queueActionItemIdAtom,
  queueActionKindAtom,
} from '../../state/mainScreen/composer';
import { useAtomValue } from 'jotai';
import { Platform } from 'react-native';
import { useAccessibilityAnnouncement } from '../../accessibility';
import { isSettledIdleActivity } from './mainScreenActivityIndicator';
import { buildAgentThreadDisplayState } from './agentThreadDisplay';
import { hasStructuredPlanCardContent, resolveWorkflowCardMode } from './planCardState';
import {
  canOfferQueuedMessageSteer,
  isBridgeConnectionErrorMessage,
  resolveDisplayedThreadPlan,
  toPersistedActivePlanState,
  resolveUndismissedPlanImplementationPrompt,
  resolvePersistedPlanImplementationPrompt,
  formatAgentThreadOptionTitle,
} from './mainScreenHelpers';
import type {
  MainScreenHeaderActivityViewModelContext,
  MainScreenHeaderActivityViewModelResult,
} from './mainScreenHeaderActivityViewModel';
import { gitCheckoutErrorAtom } from '../../state/mainScreen/gitCheckout';
import {
  collaborationModeMenuVisibleAtom,
  effortModalVisibleAtom,
  modelModalVisibleAtom,
} from '../../state/mainScreen/modals';

export type MainScreenWorkflowQueueStateContext = MainScreenHeaderActivityViewModelContext &
  MainScreenHeaderActivityViewModelResult;

export function useMainScreenWorkflowQueueState(context: MainScreenWorkflowQueueStateContext) {
  const {
    activeAgentSupports,
    agentThreadRows,
    api,
    attachmentMenuVisible,
    attachmentModalVisible,
    chatPlanSnapshotsRef,
    dismissedPlanImplementationTurnIdByThreadRef,
    displayedActivity,
    draft,
    isOpeningChat,
    pendingOptimisticQueuedMessagesRef,
    runWatchdogNow,
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
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const agentRootThreadId = useAtomValue(agentRootThreadIdAtom);
  const agentDetailThreadId = useAtomValue(agentDetailThreadIdAtom);
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  const androidKeyboardInset = useAtomValue(androidKeyboardInsetAtom);
  const composerHeight = useAtomValue(composerHeightAtom);
  const queueActionItemId = useAtomValue(queueActionItemIdAtom);
  const queueActionKind = useAtomValue(queueActionKindAtom);
  const planPanelCollapsedByThread = useAtomValue(planPanelCollapsedByThreadAtom);
  const pendingPlanImplementationPrompts = useAtomValue(pendingPlanImplementationPromptsAtom);
  const modelModalVisible = useAtomValue(modelModalVisibleAtom);
  const collaborationModeMenuVisible = useAtomValue(collaborationModeMenuVisibleAtom);
  const effortModalVisible = useAtomValue(effortModalVisibleAtom);
  const gitCheckoutError = useAtomValue(gitCheckoutErrorAtom);

  const agentDetailSummary = agentDetailThreadId
    ? (relatedAgentThreads.find((chat) => chat.id === agentDetailThreadId) ??
      api.peekChatSummary(agentDetailThreadId))
    : null;
  const agentDetailRuntime = agentDetailThreadId
    ? (threadRuntimeSnapshotsRef.current[agentDetailThreadId] ?? null)
    : null;
  const agentDetailDisplay = agentDetailSummary
    ? buildAgentThreadDisplayState(agentDetailSummary, agentDetailRuntime, runWatchdogNow)
    : null;
  const agentDetailTitle = agentDetailSummary
    ? formatAgentThreadOptionTitle(
        agentDetailSummary,
        agentRootThreadId,
        agentThreadRows.find((row) => row.chat.id === agentDetailSummary.id)?.ordinal ?? null,
      )
    : 'Sub-agent';
  const selectedThreadRuntimeSnapshot = selectedChat
    ? (threadRuntimeSnapshotsRef.current[selectedChat.id] ?? null)
    : null;
  const selectedBridgeUiSurfaces = selectedChat
    ? activeBridgeUiSurfaces.filter((surface) => surface.threadId === selectedChat.id)
    : [];
  const workflowBridgeUiSurfaces = selectedBridgeUiSurfaces.filter(
    (surface) => surface.presentation === 'workflowCard',
  );
  const bannerBridgeUiSurfaces = selectedBridgeUiSurfaces.filter(
    (surface) => surface.presentation === 'banner',
  );
  const modalBridgeUiSurface =
    selectedBridgeUiSurfaces.find((surface) => surface.presentation === 'modal') ?? null;
  const selectedBridgeQueuedMessages = selectedThreadRuntimeSnapshot?.queuedMessages ?? [];
  const selectedOptimisticQueuedMessages = selectedChat
    ? (pendingOptimisticQueuedMessagesRef.current[selectedChat.id] ?? [])
    : [];
  const showingOptimisticQueuedMessage =
    selectedBridgeQueuedMessages.length === 0 && selectedOptimisticQueuedMessages.length > 0;
  const selectedQueuedMessages = showingOptimisticQueuedMessage
    ? selectedOptimisticQueuedMessages
    : selectedBridgeQueuedMessages;
  const selectedQueueError = selectedThreadRuntimeSnapshot?.queuedMessageError ?? null;
  const oldestQueuedMessage = selectedQueuedMessages[0] ?? null;
  const oldestQueuedMessageIsPendingSteer = Boolean(
    oldestQueuedMessage &&
    selectedThreadRuntimeSnapshot?.pendingSteerMessageIds?.includes(oldestQueuedMessage.id),
  );
  const remainingQueuedMessagesCount = Math.max(0, selectedQueuedMessages.length - 1);
  const queueActionInFlight = Boolean(queueActionItemId);
  const inMemorySelectedThreadPlan = selectedChat
    ? activePlan?.threadId === selectedChat.id
      ? activePlan
      : (selectedThreadRuntimeSnapshot?.plan ??
        chatPlanSnapshotsRef.current[selectedChat.id] ??
        null)
    : null;
  const persistedSelectedThreadPlan = selectedChat
    ? toPersistedActivePlanState(selectedChat.latestPlan, selectedChat.updatedAt)
    : null;
  const selectedThreadPlan = selectedChat
    ? resolveDisplayedThreadPlan(
        inMemorySelectedThreadPlan,
        persistedSelectedThreadPlan,
        selectedThreadRuntimeSnapshot,
      )
    : null;
  const dismissedSelectedPlanTurnId = selectedChat
    ? (dismissedPlanImplementationTurnIdByThreadRef.current[selectedChat.id] ?? null)
    : null;
  const derivedSelectedPlanImplementationPrompt = selectedChat
    ? resolvePersistedPlanImplementationPrompt(selectedChat, dismissedSelectedPlanTurnId)
    : null;
  const selectedPlanImplementationPrompt = selectedChat
    ? (resolveUndismissedPlanImplementationPrompt(
        pendingPlanImplementationPrompts[selectedChat.id] ?? null,
        dismissedSelectedPlanTurnId,
      ) ?? derivedSelectedPlanImplementationPrompt)
    : null;
  const showStructuredPlanCard = hasStructuredPlanCardContent(selectedThreadPlan);
  const planPanelCollapsed = selectedChat
    ? (planPanelCollapsedByThread[selectedChat.id] ?? false)
    : false;
  const fastModeControlDisabled = isOpeningChat;
  const showSlashSuggestions = slashSuggestions.length > 0 && draft.trimStart().startsWith('/');
  const canSteerQueuedMessage = canOfferQueuedMessageSteer({
    hasQueuedMessage: Boolean(oldestQueuedMessage),
    hasSelectedThread: Boolean(selectedChatId),
    supportsSteer: activeAgentSupports?.turnSteer === true,
    isPendingSteer: oldestQueuedMessageIsPendingSteer,
    isOptimistic: showingOptimisticQueuedMessage,
    actionInFlight: queueActionInFlight,
  });
  const canCancelQueuedMessage =
    Boolean(oldestQueuedMessage) &&
    !showingOptimisticQueuedMessage &&
    !queueActionInFlight &&
    selectedThreadRuntimeSnapshot?.steeringInFlight !== true;
  const queuedMessageSteerDisabledReason = showingOptimisticQueuedMessage
    ? 'Sending the queued message to the bridge.'
    : selectedQueueError?.message
      ? selectedQueueError.message
      : queueActionKind === 'steer'
        ? 'Sending the queued message to the current turn.'
        : queueActionKind === 'cancel'
          ? 'Removing the queued message.'
          : activeAgentSupports?.turnSteer !== true
            ? 'The active agent does not support steering.'
            : null;
  const showQueuedMessageDock =
    Boolean(selectedChat) && !isOpeningChat && Boolean(oldestQueuedMessage);
  const showPlanImplementationPrompt =
    Boolean(selectedPlanImplementationPrompt) &&
    // The prompt offers to switch out of plan mode, so it is meaningless for agents
    // that have no plan mode and only publish plan/to-do updates.
    activeAgentSupports?.planMode === true &&
    !isOpeningChat &&
    !sending &&
    !creating &&
    !stoppingTurn &&
    !pendingApproval &&
    !pendingUserInputRequest &&
    !attachmentMenuVisible &&
    !attachmentModalVisible &&
    !collaborationModeMenuVisible &&
    !modelModalVisible &&
    !effortModalVisible &&
    selectedQueuedMessages.length === 0;
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
  const chatBottomInset = shouldShowComposer
    ? theme.spacing.lg
    : Math.max(theme.spacing.xxl, safeAreaInsets.bottom + theme.spacing.lg);
  const composerSafeAreaBottomInset = safeAreaInsets.bottom;
  const composerOverlayInset =
    Platform.OS === 'android' && keyboardVisible ? androidKeyboardInset : 0;
  const visibleError = !ws.isConnected && isBridgeConnectionErrorMessage(error) ? null : error;
  useAccessibilityAnnouncement(visibleError ?? userInputError ?? gitCheckoutError);
  const androidComposerReservedInset = shouldShowComposer
    ? Math.max(theme.spacing.lg, composerHeight + composerOverlayInset + theme.spacing.sm)
    : chatBottomInset;

  return {
    agentDetailSummary,
    agentDetailRuntime,
    agentDetailDisplay,
    agentDetailTitle,
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
    chatBottomInset,
    composerSafeAreaBottomInset,
    composerOverlayInset,
    visibleError,
    androidComposerReservedInset,
  };
}

export type MainScreenWorkflowQueueStateResult = ReturnType<typeof useMainScreenWorkflowQueueState>;
