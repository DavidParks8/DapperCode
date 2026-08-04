import {
  activePlanAtom,
  activeTurnIdAtom,
  errorAtom,
  liveAssistantByThreadAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../state/turn';
import {
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedServiceTierAtom,
} from '../state/models';
import {
  agentRootThreadIdAtom,
  loadingAgentThreadsAtom,
  relatedAgentThreadsAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseErrorAtom,
  workspaceRootsAtom,
} from '../../workspace/state/workspace';
import { activityAtom, queueActionItemIdAtom, queueActionKindAtom } from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type { AgentId } from '@bridge/types/types';
import { normalizeWorkspacePath } from '../helpers/helpers';
import type {
  MainScreenModelCatalogStateContext,
  MainScreenModelCatalogStateResult,
} from '../models/catalogState';
import {
  agentThreadMenuVisibleAtom,
  collaborationModeMenuVisibleAtom,
  effortModalVisibleAtom,
  modelModalVisibleAtom,
  titleDraftAtom,
  titleModalVisibleAtom,
  titleSavingAtom,
} from '../state/modals';

export type MainScreenCapabilityFlagsContext = MainScreenModelCatalogStateContext &
  MainScreenModelCatalogStateResult;

export function useMainScreenCapabilityFlags(context: MainScreenCapabilityFlagsContext) {
  const {
    agentSettings,
    agentThreadsRefreshTimerRef,
    agentThreadsRequestRef,
    api,
    attachmentController,
    clearExternalStatusFullSync,
    clearRunWatchdog,
    hadCommandRef,
    loadChatRequestRef,
    openingChatStartedAtRef,
    reasoningSummaryRef,
    selectedChat,
    selectedChatRef,
    selectedNewAgentId,
    setLoadingWorkspaceRoots,
    setOpeningChatId,
    setPendingAgentId,
    setSelectedChat,
    setSelectedChatId,
    setStreamingText,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
  } = context;
  // The controller object is rebuilt every render; only its actions are referentially stable.
  const { clear: clearAttachments } = attachmentController;
  const setError = useSetAtom(errorAtom);
  const setPendingApproval = useSetAtom(pendingApprovalAtom);
  const setPendingUserInputRequest = useSetAtom(pendingUserInputRequestAtom);
  const setUserInputDrafts = useSetAtom(userInputDraftsAtom);
  const setUserInputError = useSetAtom(userInputErrorAtom);
  const setResolvingUserInput = useSetAtom(resolvingUserInputAtom);
  const setActivePlan = useSetAtom(activePlanAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setLiveAssistantByThread = useSetAtom(liveAssistantByThreadAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setSelectedServiceTier = useSetAtom(selectedServiceTierAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const setSelectedAcpModeId = useSetAtom(selectedAcpModeIdAtom);
  const setWorkspaceRoots = useSetAtom(workspaceRootsAtom);
  const setWorkspaceBridgeRoot = useSetAtom(workspaceBridgeRootAtom);
  const setWorkspaceBrowseError = useSetAtom(workspaceBrowseErrorAtom);
  const setRelatedAgentThreads = useSetAtom(relatedAgentThreadsAtom);
  const setAgentRootThreadId = useSetAtom(agentRootThreadIdAtom);
  const setLoadingAgentThreads = useSetAtom(loadingAgentThreadsAtom);
  const setQueueActionItemId = useSetAtom(queueActionItemIdAtom);
  const setQueueActionKind = useSetAtom(queueActionKindAtom);
  const setActivity = useSetAtom(activityAtom);
  const titleDraft = useAtomValue(titleDraftAtom);
  const titleSaving = useAtomValue(titleSavingAtom);
  const setTitleModalVisible = useSetAtom(titleModalVisibleAtom);
  const setTitleDraft = useSetAtom(titleDraftAtom);
  const setTitleSaving = useSetAtom(titleSavingAtom);
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);
  const setModelModalVisible = useSetAtom(modelModalVisibleAtom);
  const setCollaborationModeMenuVisible = useSetAtom(collaborationModeMenuVisibleAtom);
  const setEffortModalVisible = useSetAtom(effortModalVisibleAtom);

  const resetComposerState = useCallback(
    (requestedAgentId?: AgentId) => {
      const nextAgentId = requestedAgentId ?? selectedNewAgentId;
      clearExternalStatusFullSync();
      loadChatRequestRef.current += 1;
      agentThreadsRequestRef.current += 1;
      if (agentThreadsRefreshTimerRef.current) {
        clearTimeout(agentThreadsRefreshTimerRef.current);
        agentThreadsRefreshTimerRef.current = null;
      }
      setRelatedAgentThreads([]);
      setAgentRootThreadId(null);
      setLoadingAgentThreads(false);
      setSelectedChat(null);
      setSelectedChatId(null);
      setPendingAgentId(nextAgentId);
      const rememberedSettings = nextAgentId ? agentSettings?.[nextAgentId] : null;
      setSelectedCollaborationMode(
        rememberedSettings?.collaborationMode === 'plan'
          ? rememberedSettings.collaborationMode
          : 'default',
      );
      setSelectedAcpModeId(null);
      openingChatStartedAtRef.current = 0;
      setOpeningChatId(null);
      setError(null);
      setSelectedServiceTier(undefined);
      setPendingApproval(null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
      setActivePlan(null);
      setStreamingText(null);
      setLiveAssistantByThread({});
      clearAttachments();
      setActiveTurnId(null);
      setStoppingTurn(false);
      setAgentThreadMenuVisible(false);
      setModelModalVisible(false);
      setCollaborationModeMenuVisible(false);
      setEffortModalVisible(false);
      setQueueActionItemId(null);
      setQueueActionKind(null);
      setActivity({
        tone: 'idle',
        title: 'Ready',
      });
      stopRequestedRef.current = false;
      stopSystemMessageLoggedRef.current = false;
      reasoningSummaryRef.current = {};
      hadCommandRef.current = false;
      clearRunWatchdog();
    },
    [
      agentSettings,
      agentThreadsRefreshTimerRef,
      agentThreadsRequestRef,
      clearAttachments,
      clearExternalStatusFullSync,
      clearRunWatchdog,
      hadCommandRef,
      loadChatRequestRef,
      openingChatStartedAtRef,
      reasoningSummaryRef,
      selectedNewAgentId,
      setActivePlan,
      setActiveTurnId,
      setActivity,
      setAgentRootThreadId,
      setAgentThreadMenuVisible,
      setCollaborationModeMenuVisible,
      setEffortModalVisible,
      setError,
      setLoadingAgentThreads,
      setLiveAssistantByThread,
      setModelModalVisible,
      setOpeningChatId,
      setPendingAgentId,
      setPendingApproval,
      setPendingUserInputRequest,
      setQueueActionItemId,
      setQueueActionKind,
      setRelatedAgentThreads,
      setResolvingUserInput,
      setSelectedAcpModeId,
      setSelectedChat,
      setSelectedChatId,
      setSelectedCollaborationMode,
      setSelectedServiceTier,
      setStoppingTurn,
      setStreamingText,
      setUserInputDrafts,
      setUserInputError,
      stopRequestedRef,
      stopSystemMessageLoggedRef,
    ],
  );

  const startNewChat = useCallback(
    (requestedAgentId?: AgentId) => {
      // New chat should land on compose/home so user can pick workspace first.
      resetComposerState(requestedAgentId);
    },
    [resetComposerState],
  );

  const openTitleEditor = useCallback(() => {
    if (!selectedChat) {
      return;
    }
    setTitleDraft(selectedChat.title);
    setTitleModalVisible(true);
    setError(null);
  }, [selectedChat, setError, setTitleDraft, setTitleModalVisible]);

  const closeTitleEditor = useCallback(() => {
    if (!titleSaving) {
      setTitleModalVisible(false);
    }
  }, [setTitleModalVisible, titleSaving]);

  const saveTitle = useCallback(async () => {
    const chat = selectedChatRef.current;
    const title = titleDraft.trim();
    if (!chat || !title || titleSaving) {
      return;
    }
    try {
      setTitleSaving(true);
      const updated = await api.renameChat(chat.id, title);
      selectedChatRef.current = updated;
      setSelectedChat(updated);
      setTitleModalVisible(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTitleSaving(false);
    }
  }, [
    api,
    selectedChatRef,
    setError,
    setSelectedChat,
    setTitleModalVisible,
    setTitleSaving,
    titleDraft,
    titleSaving,
  ]);

  const refreshWorkspaceRoots = useCallback(async () => {
    setLoadingWorkspaceRoots(true);
    try {
      const response = await api.listWorkspaceRoots();
      setWorkspaceBridgeRoot(normalizeWorkspacePath(response.bridgeRoot));
      setWorkspaceRoots(response.workspaces);
      setWorkspaceBrowseError(null);
      return response;
    } catch (err) {
      setWorkspaceBrowseError((err as Error).message);
      return null;
    } finally {
      setLoadingWorkspaceRoots(false);
    }
  }, [
    api,
    setLoadingWorkspaceRoots,
    setWorkspaceBridgeRoot,
    setWorkspaceBrowseError,
    setWorkspaceRoots,
  ]);

  return {
    resetComposerState,
    startNewChat,
    openTitleEditor,
    closeTitleEditor,
    saveTitle,
    refreshWorkspaceRoots,
  };
}

export type MainScreenCapabilityFlagsResult = ReturnType<typeof useMainScreenCapabilityFlags>;
