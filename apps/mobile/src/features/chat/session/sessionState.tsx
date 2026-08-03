import { activeTurnIdAtom, errorAtom } from '../state/turn';
import { bridgeCapabilitiesAtom, modelOptionsByAgentAtom } from '../state/models';
import { agentRootThreadIdAtom } from '../../workspace/state/workspace';
import { androidKeyboardInsetAtom, keyboardVisibleAtom } from '../state/composer';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useEffect, useMemo, useRef } from 'react';
import {
  chatModelPreferencesLoadedAtom,
  chatPlanSnapshotsLoadedAtom,
  runWatchdogNowAtom,
  selectedChatIdAtom,
} from '../state/session';
import { screenRefView } from '../state/registry';
import { threadRuntimeSnapshotsAtom } from '../state/runtime';
import { AppState, Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native';
import { findAgentDescriptor, getAgentLabel, selectAgentId } from '@shared/agents';
import type { BridgeCapabilities, BridgeUiSurface, Chat, ModelOption } from '@bridge/types/types';
import {
  type ActivePlanState,
  type PendingOptimisticUserMessage,
  type PendingOptimisticQueuedMessage,
  type ChatModelPreference,
  SLASH_COMMANDS,
  normalizeWorkspacePath,
  toApprovalPolicyForMode,
  isSlashCommandAvailable,
} from '../helpers/helpers';
import { useAttachmentController } from '../composer/controllers/attachmentController';
import { mergeModelOptions, modelOptionsFromAcpConfig } from '../state/chatState';
import { lastUsedModelPreference } from '../helpers/preferences';
import { useMountTimestampRef } from '../screen/useMountTimestampRef';
import type {
  MainScreenLifecycleRecoveryContext,
  MainScreenLifecycleRecoveryResult,
} from './lifecycleRecovery';
import { EMPTY_MODEL_OPTIONS } from '../screen/constants';

export type MainScreenChatSessionStateContext = MainScreenLifecycleRecoveryContext &
  MainScreenLifecycleRecoveryResult;

function resolveReadyAgents(bridgeCapabilities: BridgeCapabilities | null) {
  return bridgeCapabilities?.agents.filter((agent) => agent.lifecycle === 'ready') ?? [];
}

function resolveSelectedNewAgentId(options: {
  bridgeCapabilities: BridgeCapabilities | null;
  pendingAgentId: string | null;
  preferredAgentId: string | null;
}) {
  const { bridgeCapabilities, pendingAgentId, preferredAgentId } = options;
  const preferredSelection = pendingAgentId ?? preferredAgentId;
  return bridgeCapabilities
    ? selectAgentId(preferredSelection, bridgeCapabilities)
    : (preferredSelection ?? null);
}

function resolveActiveAgentState(options: {
  bridgeCapabilities: BridgeCapabilities | null;
  selectedChat: Chat | null;
  selectedChatId: string | null;
  selectedNewAgentId: string | null;
}) {
  const { bridgeCapabilities, selectedChat, selectedChatId, selectedNewAgentId } = options;
  const activeAgentId = selectedChat?.agentId ?? selectedNewAgentId;
  const activeAgent = findAgentDescriptor(bridgeCapabilities?.agents ?? [], activeAgentId);
  const activeAgentLabel = getAgentLabel(bridgeCapabilities?.agents ?? [], activeAgentId);
  const activeAgentSupports = activeAgentId
    ? (bridgeCapabilities?.supportsByAgent[activeAgentId] ?? null)
    : null;
  const supportsFastMode = activeAgentSupports?.fastMode === true;
  const supportsReview = activeAgentSupports?.reviewStart === true;
  const supportsGoal = activeAgentSupports?.goalSlash === true;
  const supportsPlanMode = activeAgentSupports?.planMode === true;
  const slashCommandAvailability = {
    hasOpenChat: Boolean(selectedChatId),
    supportsGoal,
    supportsPlanMode,
    supportsReview,
  };

  return {
    activeAgentId,
    activeAgent,
    activeAgentLabel,
    activeAgentSupports,
    supportsFastMode,
    supportsReview,
    supportsGoal,
    supportsPlanMode,
    slashCommandAvailability,
    activeSlashCommands: SLASH_COMMANDS.filter((command) =>
      isSlashCommandAvailable(command, slashCommandAvailability),
    ),
  };
}

function resolveAcpOption(
  activeAcpConfig: Chat['acpConfig'] | undefined,
  category: 'mode' | 'model' | 'thought_level',
) {
  return activeAcpConfig?.find((option) => option.category === category) ?? null;
}

function resolveModelState(options: {
  selectedChat: Chat | null;
  activeAgentId: string | null;
  modelOptionsByAgent: Record<string, ModelOption[]>;
}) {
  const { selectedChat, activeAgentId, modelOptionsByAgent } = options;
  const activeAcpConfig = selectedChat?.acpConfig ?? [];
  const snapshotModelOptions = modelOptionsFromAcpConfig(activeAcpConfig);
  const catalogModelOptions = activeAgentId
    ? (modelOptionsByAgent[activeAgentId] ?? EMPTY_MODEL_OPTIONS)
    : EMPTY_MODEL_OPTIONS;

  return {
    activeAcpConfig,
    modelConfig: resolveAcpOption(activeAcpConfig, 'model'),
    effortConfig: resolveAcpOption(activeAcpConfig, 'thought_level'),
    modeConfig: resolveAcpOption(activeAcpConfig, 'mode'),
    snapshotModelOptions,
    catalogModelOptions,
    modelOptions:
      snapshotModelOptions.length > 0
        ? mergeModelOptions(catalogModelOptions, snapshotModelOptions)
        : catalogModelOptions,
  };
}

function resolveAgentDefaults(
  agentSettings: MainScreenChatSessionStateContext['agentSettings'],
  selectedNewAgentId: string | null,
) {
  const pendingAgentDefaults = selectedNewAgentId
    ? (agentSettings?.[selectedNewAgentId] ?? null)
    : null;

  return {
    pendingAgentDefaults,
    preferredCollaborationMode:
      pendingAgentDefaults?.collaborationMode === 'plan'
        ? pendingAgentDefaults.collaborationMode
        : 'default',
  };
}

function resolvePreferredModelDefaults(
  chatModelPreferences: Record<string, ChatModelPreference>,
  selectedNewAgentId: string | null,
) {
  const preferredAgentModelPreference = lastUsedModelPreference(
    chatModelPreferences,
    selectedNewAgentId,
  );

  return {
    preferredDefaultModelId: preferredAgentModelPreference?.modelId ?? null,
    preferredDefaultEffort: preferredAgentModelPreference?.effort ?? null,
    preferredServiceTier: undefined,
  };
}

export function useMainScreenChatSessionState(context: MainScreenChatSessionStateContext) {
  const {
    agentSettings,
    api,
    approvalMode,
    defaultStartCwd,
    draft,
    pendingAgentId,
    preferredAgentId,
    replayRecoveryAbortControllerRef,
    replayRecoveryGenerationRef,
    replayRecoveryRetryTimerRef,
    selectedChat,
    selectedChatId,
  } = context;
  const store = useStore();
  const setError = useSetAtom(errorAtom);
  const bridgeCapabilities = useAtomValue(bridgeCapabilitiesAtom);
  const modelOptionsByAgent = useAtomValue(modelOptionsByAgentAtom);
  const setKeyboardVisible = useSetAtom(keyboardVisibleAtom);
  const setAndroidKeyboardInset = useSetAtom(androidKeyboardInsetAtom);

  useEffect(() => {
    return () => {
      replayRecoveryGenerationRef.current += 1;
      replayRecoveryAbortControllerRef.current?.abort();
      replayRecoveryAbortControllerRef.current = null;
      if (replayRecoveryRetryTimerRef.current) {
        clearTimeout(replayRecoveryRetryTimerRef.current);
        replayRecoveryRetryTimerRef.current = null;
      }
    };
  }, [replayRecoveryAbortControllerRef, replayRecoveryGenerationRef, replayRecoveryRetryTimerRef]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      setKeyboardVisible(true);

      if (Platform.OS !== 'android') {
        return;
      }

      const keyboardTop = event.endCoordinates?.screenY;
      const keyboardHeight = event.endCoordinates?.height ?? 0;
      const screenHeight = Dimensions.get('screen').height;
      const overlap =
        typeof keyboardTop === 'number' && Number.isFinite(keyboardTop)
          ? Math.max(0, screenHeight - keyboardTop)
          : Math.max(0, keyboardHeight);
      setAndroidKeyboardInset(overlap);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
      setAndroidKeyboardInset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [setAndroidKeyboardInset, setKeyboardVisible]);

  // Live views so callbacks always read the newest value without re-subscribing. They are
  // memoized on the store so every consumer that lists one as a hook dependency keeps a stable
  // identity across renders.
  const chatIdRef = useMemo(() => screenRefView(store, selectedChatIdAtom), [store]);
  const selectedChatRef = useRef<Chat | null>(selectedChat);
  selectedChatRef.current = selectedChat;
  const selectedChatIdRef = useRef<string | null>(selectedChatId);
  selectedChatIdRef.current = selectedChatId;
  const parentChatCacheRef = useRef<Record<string, Chat>>({});
  const agentRootThreadIdRef = useMemo(() => screenRefView(store, agentRootThreadIdAtom), [store]);
  const planPanelLastTurnByThreadRef = useRef<Record<string, string>>({});
  const planItemTurnIdByThreadRef = useRef<Record<string, string>>({});
  const autoEnabledPlanTurnIdByThreadRef = useRef<Record<string, string>>({});
  const dismissedPlanImplementationTurnIdByThreadRef = useRef<Record<string, string>>({});
  const activeTurnIdRef = useMemo(() => screenRefView(store, activeTurnIdAtom), [store]);
  const stopRequestedRef = useRef(false);
  const stopSystemMessageLoggedRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const lastAppForegroundedAtRef = useMountTimestampRef(appStateRef.current === 'active');
  const deferredDisconnectActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether a command arrived since the last delta — used to
  // know when a new thinking segment starts so we can replace the old one.
  const hadCommandRef = useRef(false);
  const reasoningSummaryRef = useRef<Record<string, string>>({});
  const reasoningBufferRef = useRef('');
  const liveReasoningBuffersRef = useRef<Record<string, string>>({});
  const liveReasoningMessageIdsRef = useRef<Record<string, string>>({});
  const runWatchdogUntilRef = useRef(0);
  const runWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runWatchdogNow = useAtomValue(runWatchdogNowAtom);
  const setRunWatchdogNow = useSetAtom(runWatchdogNowAtom);
  const externalStatusFullSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalStatusFullSyncInFlightRef = useRef(false);
  const externalStatusFullSyncQueuedThreadRef = useRef<string | null>(null);
  const externalStatusFullSyncNextAllowedAtRef = useRef(0);
  const threadRuntimeSnapshotsRef = useMemo(
    () => screenRefView(store, threadRuntimeSnapshotsAtom),
    [store],
  );
  const threadReasoningBuffersRef = useRef<Record<string, string>>({});
  const pendingOptimisticUserMessagesRef = useRef<Record<string, PendingOptimisticUserMessage[]>>(
    {},
  );
  const pendingOptimisticQueuedMessagesRef = useRef<
    Record<string, PendingOptimisticQueuedMessage[]>
  >({});
  const chatModelPreferencesRef = useRef<Record<string, ChatModelPreference>>({});
  const chatModelPreferencesLoaded = useAtomValue(chatModelPreferencesLoadedAtom);
  const setChatModelPreferencesLoaded = useSetAtom(chatModelPreferencesLoadedAtom);
  const chatPlanSnapshotsRef = useRef<Record<string, ActivePlanState>>({});
  const bridgeUiSurfaceSnapshotsRef = useRef<Record<string, BridgeUiSurface[]>>({});
  const setChatPlanSnapshotsLoaded = useSetAtom(chatPlanSnapshotsLoadedAtom);
  const bridgeUiSurfacePersistenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferredStartCwd = normalizeWorkspacePath(defaultStartCwd);
  const readyAgents = resolveReadyAgents(bridgeCapabilities);
  const selectedNewAgentId = resolveSelectedNewAgentId({
    bridgeCapabilities,
    pendingAgentId,
    preferredAgentId,
  });
  const {
    activeAgentId,
    activeAgent,
    activeAgentLabel,
    activeAgentSupports,
    supportsFastMode,
    supportsReview,
    supportsGoal,
    supportsPlanMode,
    slashCommandAvailability,
    activeSlashCommands,
  } = resolveActiveAgentState({
    bridgeCapabilities,
    selectedChat,
    selectedChatId,
    selectedNewAgentId,
  });
  const {
    activeAcpConfig,
    modelConfig,
    effortConfig,
    modeConfig,
    snapshotModelOptions,
    catalogModelOptions,
    modelOptions,
  } = resolveModelState({
    selectedChat,
    activeAgentId,
    modelOptionsByAgent,
  });
  const { pendingAgentDefaults, preferredCollaborationMode } = resolveAgentDefaults(
    agentSettings,
    selectedNewAgentId,
  );
  const { preferredDefaultModelId, preferredDefaultEffort, preferredServiceTier } =
    resolvePreferredModelDefaults(chatModelPreferencesRef.current, selectedNewAgentId);
  const activeApprovalPolicy = toApprovalPolicyForMode(approvalMode);
  const attachmentController = useAttachmentController({
    api,
    chat: selectedChat,
    draft,
    setError,
  });
  const {
    attachmentModalVisible,
    attachmentMenuVisible,
    attachmentPathDraft,
    setAttachmentPathDraft,
    pendingMentionPaths,
    pendingLocalImagePaths,
    pickerBusy: attachmentPickerBusy,
    uploading: uploadingAttachment,
    hasFailedUploads: hasFailedAttachmentUploads,
    composerAttachments,
    openMenu: openAttachmentMenu,
    closePathModal: closeAttachmentModal,
    submitPath: submitAttachmentPath,
    removeComposerAttachment,
    removeMentionPath: removePendingMentionPath,
    retryFailedUploads,
  } = attachmentController;

  return {
    chatIdRef,
    selectedChatRef,
    selectedChatIdRef,
    parentChatCacheRef,
    agentRootThreadIdRef,
    planPanelLastTurnByThreadRef,
    planItemTurnIdByThreadRef,
    autoEnabledPlanTurnIdByThreadRef,
    dismissedPlanImplementationTurnIdByThreadRef,
    activeTurnIdRef,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    appStateRef,
    lastAppForegroundedAtRef,
    deferredDisconnectActivityTimeoutRef,
    hadCommandRef,
    reasoningSummaryRef,
    reasoningBufferRef,
    liveReasoningBuffersRef,
    liveReasoningMessageIdsRef,
    runWatchdogUntilRef,
    runWatchdogTimerRef,
    runWatchdogNow,
    setRunWatchdogNow,
    externalStatusFullSyncTimerRef,
    externalStatusFullSyncInFlightRef,
    externalStatusFullSyncQueuedThreadRef,
    externalStatusFullSyncNextAllowedAtRef,
    threadRuntimeSnapshotsRef,
    threadReasoningBuffersRef,
    pendingOptimisticUserMessagesRef,
    pendingOptimisticQueuedMessagesRef,
    chatModelPreferencesRef,
    chatModelPreferencesLoaded,
    setChatModelPreferencesLoaded,
    chatPlanSnapshotsRef,
    bridgeUiSurfaceSnapshotsRef,
    setChatPlanSnapshotsLoaded,
    bridgeUiSurfacePersistenceTimeoutRef,
    preferredStartCwd,
    readyAgents,
    selectedNewAgentId,
    activeAgentId,
    activeAgent,
    activeAgentLabel,
    activeAgentSupports,
    supportsFastMode,
    supportsReview,
    supportsGoal,
    supportsPlanMode,
    slashCommandAvailability,
    activeSlashCommands,
    activeAcpConfig,
    modelConfig,
    effortConfig,
    modeConfig,
    snapshotModelOptions,
    catalogModelOptions,
    modelOptions,
    pendingAgentDefaults,
    preferredDefaultModelId,
    preferredDefaultEffort,
    preferredServiceTier,
    preferredCollaborationMode,
    activeApprovalPolicy,
    attachmentController,
    attachmentModalVisible,
    attachmentMenuVisible,
    attachmentPathDraft,
    setAttachmentPathDraft,
    pendingMentionPaths,
    pendingLocalImagePaths,
    attachmentPickerBusy,
    uploadingAttachment,
    hasFailedAttachmentUploads,
    composerAttachments,
    openAttachmentMenu,
    closeAttachmentModal,
    submitAttachmentPath,
    removeComposerAttachment,
    removePendingMentionPath,
    retryFailedUploads,
  };
}

export type MainScreenChatSessionStateResult = ReturnType<typeof useMainScreenChatSessionState>;
