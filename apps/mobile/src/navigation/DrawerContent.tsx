import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Alert, AppState } from 'react-native';
import type { AgentDescriptor, ChatSummary } from '../api/types';
import { confirmAction } from '../components/confirm';
import { workspaceChatLimitAtom } from '../state/appState/settings';
import { useBridgeApi, useBridgeWs } from '../state/bridge/hooks';
import { selectedChatIdAtom } from '../state/chat/atoms';
import { navigateAtom, selectChatAtom, startNewChatAtom } from '../state/navigation/actions';
import { useAppTheme } from '../theme';
import { buildDrawerAttentionModel, type DrawerAttentionLane } from './drawerAttention';
import { createDrawerContentStyles } from './drawerContentStyles';
import type { DrawerContentProps, DrawerScreen } from './drawerContentTypes';
import { DrawerContentView } from './DrawerContentView';
import { DrawerContentViewContext } from './drawerContentViewContext';
import { normalizeWorkspaceChatLimit } from './drawerContentHelpers';
import { useDrawerAttentionRequests } from './useDrawerAttentionRequests';
import { useDrawerChatLoading } from './useDrawerChatLoading';

const DRAWER_EVENT_REFRESH_DEBOUNCE_MS = 250;

function chatDeletionFamily(chats: ChatSummary[], rootId: string): ChatSummary[] {
  const affectedIds = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const chat of chats) {
      if (
        chat.parentThreadId &&
        affectedIds.has(chat.parentThreadId) &&
        !affectedIds.has(chat.id)
      ) {
        affectedIds.add(chat.id);
        changed = true;
      }
    }
  }
  return chats.filter((chat) => affectedIds.has(chat.id));
}

export const DrawerContent = memo(function DrawerContentComponent({
  active,
  onClose,
}: DrawerContentProps) {
  const theme = useAppTheme();
  const api = useBridgeApi();
  const ws = useBridgeWs();
  const workspaceChatLimit = useAtomValue(workspaceChatLimitAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const onSelectChat = useSetAtom(selectChatAtom);
  const onNewChat = useSetAtom(startNewChatAtom);
  const onNavigate = useSetAtom(navigateAtom);
  const {
    pendingApprovals,
    pendingUserInputs,
    attentionRequestError,
    refreshingAttentionRequests,
    refreshAttentionRequests,
  } = useDrawerAttentionRequests(api, ws, active);
  const priorityThreadIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...pendingApprovals.map((approval) => approval.threadId),
          ...pendingUserInputs.map((request) => request.threadId),
        ]),
      ),
    [pendingApprovals, pendingUserInputs],
  );
  const {
    chats,
    loading,
    loadingOlderChats,
    partialHistoryDiagnostics,
    refreshing,
    runIndicatorsByThread,
    wsConnected,
    loadChats,
    removeChat,
    restoreChat,
    retryDeepChatListRef,
    cancelChatListStream,
    scheduleLoadChats,
  } = useDrawerChatLoading(api, ws, active, priorityThreadIds);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [agentMetadataError, setAgentMetadataError] = useState<string | null>(null);
  const [selectedFolderKey, setSelectedFolderKey] = useState<string | null>(null);
  const [collapsedLaneKeys, setCollapsedLaneKeys] = useState<Set<DrawerAttentionLane>>(new Set());
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const mountedRef = useRef(true);
  const styles = useMemo(() => createDrawerContentStyles(theme), [theme]);
  const normalizedWorkspaceChatLimit = normalizeWorkspaceChatLimit(workspaceChatLimit);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAgentMetadata = useCallback(async () => {
    try {
      const capabilities = await api.readBridgeCapabilities();
      if (!mountedRef.current) {
        return;
      }
      setAgents(capabilities.agents);
      setAgentMetadataError(null);
    } catch {
      if (mountedRef.current) {
        setAgentMetadataError('Could not refresh agent names.');
      }
    }
  }, [api]);

  useEffect(() => {
    void refreshAgentMetadata();
  }, [refreshAgentMetadata]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return ws.onStatus((connected) => {
      if (connected) {
        void refreshAgentMetadata();
      }
    });
  }, [active, refreshAgentMetadata, ws]);

  const attentionModel = useMemo(
    () =>
      buildDrawerAttentionModel({
        chats,
        agents,
        runIndicatorsByThread,
        pendingApprovals,
        pendingUserInputs,
        selectedFolderKey,
        workspaceChatLimit: normalizedWorkspaceChatLimit,
      }),
    [
      agents,
      chats,
      normalizedWorkspaceChatLimit,
      pendingApprovals,
      pendingUserInputs,
      runIndicatorsByThread,
      selectedFolderKey,
    ],
  );

  useEffect(() => {
    if (
      selectedFolderKey &&
      !attentionModel.folderOptions.some((option) => option.key === selectedFolderKey)
    ) {
      setSelectedFolderKey(null);
    }
  }, [attentionModel.folderOptions, selectedFolderKey]);

  const visibleAttentionSections = useMemo(
    () =>
      attentionModel.sections.map((section) =>
        collapsedLaneKeys.has(section.key)
          ? {
              ...section,
              data: [],
            }
          : section,
      ),
    [attentionModel.sections, collapsedLaneKeys],
  );

  const toggleAttentionSection = useCallback((lane: DrawerAttentionLane) => {
    setCollapsedLaneKeys((previous) => {
      const next = new Set(previous);
      if (next.has(lane)) {
        next.delete(lane);
      } else {
        next.add(lane);
      }
      return next;
    });
  }, []);

  const handleSelectFolder = useCallback((folderKey: string | null) => {
    setSelectedFolderKey(folderKey);
    setFolderPickerVisible(false);
  }, []);

  const handleOpenFolderPicker = useCallback(() => {
    setFolderPickerVisible(true);
  }, []);

  const refreshDrawer = useCallback(async () => {
    await Promise.all([loadChats(true, true), refreshAttentionRequests(), refreshAgentMetadata()]);
  }, [loadChats, refreshAgentMetadata, refreshAttentionRequests]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setCollapsedLaneKeys(new Set());
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
        void refreshAttentionRequests();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [active, refreshAttentionRequests, scheduleLoadChats]);

  const handleSelectChat = useCallback(
    (chatId: string) => {
      cancelChatListStream();
      onSelectChat(chatId);
    },
    [cancelChatListStream, onSelectChat],
  );

  const handleNewChat = useCallback(() => {
    cancelChatListStream();
    onNewChat();
  }, [cancelChatListStream, onNewChat]);

  /**
   * Removes the row before the bridge answers so the list feels immediate, and puts it back when
   * the agent refuses so the drawer never lies about what still exists.
   */
  const handleDeleteChat = useCallback(
    async (chatId: string): Promise<boolean> => {
      const chat = chats.find((entry) => entry.id === chatId);
      const affectedChats = chatDeletionFamily(chats, chatId);
      const affectedChatIds = new Set([chatId, ...affectedChats.map((entry) => entry.id)]);
      const descendantCount = affectedChats.filter((entry) => entry.id !== chatId).length;
      const chatTitle = chat?.title?.trim();
      const deleteSubject = chatTitle ? `“${chatTitle}”` : 'This session';
      const descendantSuffix =
        descendantCount > 0
          ? ` and ${String(descendantCount)} linked sub-${descendantCount === 1 ? 'session' : 'sessions'}`
          : '';
      const confirmed = await confirmAction({
        title: 'Delete session?',
        message: `${deleteSubject}${descendantSuffix} will be removed from this agent’s history.`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!confirmed) {
        return false;
      }
      for (const affectedChatId of affectedChatIds) {
        removeChat(affectedChatId);
      }
      try {
        await api.deleteChat(chatId);
        for (const affectedChatId of affectedChatIds) {
          if (affectedChatId !== chatId) {
            api.forgetChat(affectedChatId);
          }
        }
      } catch {
        for (const affectedChat of affectedChats) {
          restoreChat(affectedChat);
        }
        Alert.alert(
          'Could not delete session',
          'The session was restored. Check the bridge connection and try again.',
        );
        return false;
      }
      if (selectedChatId && affectedChatIds.has(selectedChatId)) {
        onNewChat();
      }
      return true;
    },
    [api, chats, onNewChat, removeChat, restoreChat, selectedChatId],
  );

  const handleNavigate = useCallback(
    (screen: DrawerScreen) => {
      cancelChatListStream();
      onNavigate(screen);
    },
    [cancelChatListStream, onNavigate],
  );

  const resolvedEmptyTitle =
    chats.length === 0
      ? 'No sessions yet'
      : selectedFolderKey
        ? `No sessions in ${attentionModel.selectedFolderLabel}`
        : 'No sessions to show';
  const resolvedEmptyHint =
    chats.length === 0
      ? 'Start a new chat and it will appear here with live activity.'
      : 'Choose another folder to see its sessions.';
  const noticeMessages = [
    attentionRequestError,
    agentMetadataError,
    ...partialHistoryDiagnostics,
  ].filter((message): message is string => Boolean(message));

  const viewModel = {
    attentionCount: attentionModel.attentionCount,
    collapsedLaneKeys,
    folderOptions: attentionModel.folderOptions,
    folderPickerVisible,
    handleClose: onClose,
    handleDismissFolderPicker: () => setFolderPickerVisible(false),
    handleDeleteChat,
    handleNavigate,
    handleNewChat,
    handleOpenFolderPicker,
    handleSelectChat,
    handleSelectFolder,
    loading,
    loadingOlderChats,
    noticeMessages,
    recentCount: attentionModel.recentCount,
    refreshing: refreshing || refreshingAttentionRequests,
    refreshDrawer,
    resolvedEmptyHint,
    resolvedEmptyTitle,
    retryDeepChatListRef,
    selectedChatId,
    selectedFolderKey,
    selectedFolderLabel: attentionModel.selectedFolderLabel,
    styles,
    theme,
    toggleAttentionSection,
    totalChatCount: attentionModel.sessionCount,
    visibleAttentionSections,
    visibleChatCount: attentionModel.visibleChatCount,
    workingCount: attentionModel.workingCount,
    wsConnected,
  };
  return (
    <DrawerContentViewContext.Provider value={viewModel}>
      <DrawerContentView />
    </DrawerContentViewContext.Provider>
  );
});
