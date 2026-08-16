import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Alert, AppState, Keyboard } from 'react-native';
import type { ChatSummary } from '@bridge/types/types';
import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { confirmAction } from '@shared/ui/confirm';
import { feedback } from '@shared/feedback';
import { confirmSessionDeletionAtom, workspaceChatLimitAtom } from '@shell/state/appState/settings';
import { useBridgeApi, useBridgeWs } from '@shell/state/bridge/hooks';
import { useBridgeCapabilitiesResource } from '@shell/state/bridge/capabilities';
import { selectedChatIdAtom } from '@shell/state/chat/atoms';
import {
  navigateAtom,
  openBridgeConnectionAtom,
  selectChatAtom,
  startNewChatAtom,
} from '@shell/navigation/actions';
import { useAppTheme } from '@shared/theme';
import {
  buildDrawerAttentionModel,
  type DrawerAttentionLane,
} from '@shell/navigation/drawerAttention';
import { createDrawerContentStyles } from '@shell/navigation/drawerContentStyles';
import type { DrawerContentProps, DrawerScreen } from '@shell/navigation/drawerContentTypes';
import { DrawerContentView } from '@shell/navigation/DrawerContentView';
import { DrawerContentViewContext } from '@shell/navigation/drawerContentViewContext';
import {
  filterDrawerAttentionSections,
  normalizeWorkspaceChatLimit,
} from '@shell/navigation/drawerContentHelpers';
import { useDrawerAttentionRequests } from '@shell/navigation/useDrawerAttentionRequests';
import { useDrawerChatLoading } from '@shell/navigation/useDrawerChatLoading';

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
  const confirmSessionDeletion = useAtomValue(confirmSessionDeletionAtom);
  const workspaceChatLimit = useAtomValue(workspaceChatLimitAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const onSelectChat = useSetAtom(selectChatAtom);
  const onNewChat = useSetAtom(startNewChatAtom);
  const onNavigate = useSetAtom(navigateAtom);
  const onOpenConnection = useSetAtom(openBridgeConnectionAtom);
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
    resetPollTimer,
  } = useDrawerChatLoading(api, ws, active, priorityThreadIds);
  const {
    value: bridgeCapabilities,
    error: capabilitiesError,
    refresh: refreshAgentMetadata,
  } = useBridgeCapabilitiesResource();
  const agents = useMemo(() => bridgeCapabilities?.agents ?? [], [bridgeCapabilities?.agents]);
  const agentMetadataError = capabilitiesError ? 'Could not refresh agent names.' : null;
  const [selectedFolderKey, setSelectedFolderKey] = useState<string | null>(null);
  const [collapsedLaneKeys, setCollapsedLaneKeys] = useState<Set<DrawerAttentionLane>>(new Set());
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedSearchQuery = searchQuery.trim();
  const isSearching = trimmedSearchQuery.length > 0;
  const styles = useMemo(() => createDrawerContentStyles(theme), [theme]);
  const normalizedWorkspaceChatLimit = normalizeWorkspaceChatLimit(workspaceChatLimit);

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

  const visibleAttentionSections = useMemo(() => {
    // While searching, matches must surface regardless of collapsed-lane state — a collapsed
    // "Working now" lane should still reveal a hit rather than hide it — so search filters the
    // full model instead of the collapse-adjusted one used outside of search.
    if (isSearching) {
      return filterDrawerAttentionSections(attentionModel.sections, trimmedSearchQuery);
    }
    return attentionModel.sections.map((section) =>
      collapsedLaneKeys.has(section.key)
        ? {
            ...section,
            data: [],
          }
        : section,
    );
  }, [attentionModel.sections, collapsedLaneKeys, isSearching, trimmedSearchQuery]);

  const searchResultCount = useMemo(
    () => visibleAttentionSections.reduce((total, section) => total + section.data.length, 0),
    [visibleAttentionSections],
  );

  const searchAnnouncementMessage = isSearching
    ? searchResultCount === 0
      ? `No sessions match "${trimmedSearchQuery}"`
      : `${String(searchResultCount)} ${searchResultCount === 1 ? 'session matches' : 'sessions match'} "${trimmedSearchQuery}"`
    : null;

  // Search is the ONLY announcement channel for result counts/no-results: the visual result
  // summary and empty-state copy intentionally omit accessibilityLiveRegion so a screen reader
  // doesn't hear the same update twice. Debounce so rapid typing settles before announcing
  // instead of firing once per keystroke.
  const [debouncedSearchAnnouncement, setDebouncedSearchAnnouncement] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!isSearching) {
      setDebouncedSearchAnnouncement(null);
      return;
    }
    const timeout = setTimeout(() => {
      setDebouncedSearchAnnouncement(searchAnnouncementMessage);
    }, 400);
    return () => clearTimeout(timeout);
  }, [isSearching, searchAnnouncementMessage]);

  useAccessibilityAnnouncement(debouncedSearchAnnouncement);

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    void feedback.selection();
  }, []);

  const handleOpenConnection = useCallback(() => {
    cancelChatListStream();
    onOpenConnection();
  }, [cancelChatListStream, onOpenConnection]);

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
        resetPollTimer(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
        void refreshAttentionRequests();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [active, refreshAttentionRequests, resetPollTimer]);

  const handleSelectChat = useCallback(
    (chatId: string) => {
      void feedback.selection();
      cancelChatListStream();
      onClose?.();
      onSelectChat(chatId);
    },
    [cancelChatListStream, onClose, onSelectChat],
  );

  const handleNewChat = useCallback(() => {
    Keyboard.dismiss();
    cancelChatListStream();
    onNewChat();
  }, [cancelChatListStream, onNewChat]);

  /**
   * Removes the row before the bridge answers so the list feels immediate, and puts it back when
   * the agent refuses so the drawer never lies about what still exists.
   */
  const handleDeleteChat = useCallback(
    async (chatId: string): Promise<boolean> => {
      const affectedChats = chatDeletionFamily(chats, chatId);
      const affectedChatIds = new Set([chatId, ...affectedChats.map((entry) => entry.id)]);
      if (confirmSessionDeletion) {
        const chat = chats.find((entry) => entry.id === chatId);
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
      }
      void feedback.destructive();
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
    [api, chats, confirmSessionDeletion, onNewChat, removeChat, restoreChat, selectedChatId],
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
    handleClearSearch,
    handleClose: onClose,
    handleDismissFolderPicker: () => setFolderPickerVisible(false),
    handleDeleteChat,
    handleNavigate,
    handleNewChat,
    handleOpenConnection,
    handleOpenFolderPicker,
    handleSearchQueryChange,
    handleSelectChat,
    handleSelectFolder,
    hasAnySessions: chats.length > 0,
    isSearching,
    loading,
    loadingOlderChats,
    noticeMessages,
    recentCount: attentionModel.recentCount,
    refreshing: refreshing || refreshingAttentionRequests,
    refreshDrawer,
    resolvedEmptyHint,
    resolvedEmptyTitle,
    retryDeepChatListRef,
    searchQuery,
    searchResultCount,
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
