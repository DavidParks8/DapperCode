import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Alert, AppState, Keyboard } from 'react-native';
import type { HostBridgeApiClient } from '@bridge/client/client';
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
  areAllChatIdsSelected,
  collectSelectableChatIds,
  describeBulkDeleteFailure,
  describeBulkDeletion,
  pruneSelectedChatIds,
  resolveBulkDeleteRootIds,
  toggleSelectedChatId,
} from '@shell/navigation/drawerSelection';
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

type BulkDeletionFamily = { rootId: string; chats: ChatSummary[] };

/** Expands the selection into the exact set of sessions a bulk delete will remove. */
function buildBulkDeletionPlan(
  chats: ChatSummary[],
  selectedChatIds: ReadonlySet<string>,
): { families: BulkDeletionFamily[]; affectedChatIds: Set<string> } {
  const families = resolveBulkDeleteRootIds(chats, selectedChatIds).map((rootId) => ({
    rootId,
    chats: chatDeletionFamily(chats, rootId),
  }));
  const affectedChatIds = new Set<string>();
  for (const family of families) {
    affectedChatIds.add(family.rootId);
    for (const chat of family.chats) {
      affectedChatIds.add(chat.id);
    }
  }
  return { families, affectedChatIds };
}

async function deleteBulkDeletionFamilies(
  api: Pick<HostBridgeApiClient, 'deleteChat' | 'forgetChat'>,
  families: BulkDeletionFamily[],
): Promise<{ failedFamilies: BulkDeletionFamily[]; deletedChatIds: Set<string> }> {
  const failedFamilies: BulkDeletionFamily[] = [];
  const deletedChatIds = new Set<string>();
  for (const family of families) {
    try {
      await api.deleteChat(family.rootId);
      deletedChatIds.add(family.rootId);
      for (const chat of family.chats) {
        if (chat.id !== family.rootId) {
          api.forgetChat(chat.id);
          deletedChatIds.add(chat.id);
        }
      }
    } catch {
      failedFamilies.push(family);
    }
  }
  return { failedFamilies, deletedChatIds };
}

function restoreBulkDeletionFamilies(
  families: BulkDeletionFamily[],
  restoreChat: (chat: ChatSummary) => void,
): Set<string> {
  const restoredChatIds = new Set<string>();
  for (const family of families) {
    for (const chat of family.chats) {
      restoreChat(chat);
      restoredChatIds.add(chat.id);
    }
  }
  return restoredChatIds;
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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<ReadonlySet<string>>(() => new Set());
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

  const selectableChatIds = useMemo(
    () => collectSelectableChatIds(visibleAttentionSections),
    [visibleAttentionSections],
  );
  const allSelectableChatsSelected = areAllChatIdsSelected(selectableChatIds, selectedChatIds);
  const selectedChatCount = selectedChatIds.size;

  // A session deleted from another client (or filtered out of the loaded window) must not stay
  // selected behind the scenes, or the delete button would count rows the drawer no longer has.
  useEffect(() => {
    setSelectedChatIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }
      return pruneSelectedChatIds(
        previous,
        chats.map((chat) => chat.id),
      );
    });
  }, [chats]);

  // Selection is a transient mode: reopening the drawer should never resume a stale "3 Selected".
  useEffect(() => {
    if (active) {
      return;
    }
    setSelectionMode(false);
    setSelectedChatIds(new Set());
  }, [active]);

  const enterSelectionMode = useCallback(() => {
    Keyboard.dismiss();
    // Collapsed lanes would hide rows that "Select All" and the delete count still include, so
    // selection always starts from a fully expanded list.
    setCollapsedLaneKeys(new Set());
    setSelectedChatIds(new Set());
    setSelectionMode(true);
    void feedback.selection();
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedChatIds(new Set());
    void feedback.selection();
  }, []);

  const toggleChatSelection = useCallback((chatId: string) => {
    void feedback.selection();
    setSelectedChatIds((previous) => toggleSelectedChatId(previous, chatId));
  }, []);

  const toggleSelectAllChats = useCallback(() => {
    void feedback.selection();
    setSelectedChatIds((previous) =>
      areAllChatIdsSelected(selectableChatIds, previous) ? new Set() : new Set(selectableChatIds),
    );
  }, [selectableChatIds]);

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
        onNewChat({ keepDrawerOpen: true });
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

  /**
   * Bulk sibling of `handleDeleteChat`: one confirmation for the whole selection, one optimistic
   * removal pass, then a per-session delete. Sessions the bridge refuses are restored and stay
   * selected so the user can retry exactly those without rebuilding the selection.
   */
  const handleDeleteSelectedChats = useCallback(async (): Promise<boolean> => {
    if (selectedChatIds.size === 0) {
      return false;
    }
    const { families, affectedChatIds } = buildBulkDeletionPlan(chats, selectedChatIds);
    if (families.length === 0) {
      setSelectionMode(false);
      setSelectedChatIds(new Set());
      return false;
    }
    if (confirmSessionDeletion) {
      const linkedCount = Array.from(affectedChatIds).filter(
        (chatId) => !selectedChatIds.has(chatId),
      ).length;
      const { title, message } = describeBulkDeletion(selectedChatIds.size, linkedCount);
      const confirmed = await confirmAction({
        title,
        message,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!confirmed) {
        return false;
      }
    }
    void feedback.destructive();
    for (const chatId of affectedChatIds) {
      removeChat(chatId);
    }
    const { failedFamilies, deletedChatIds } = await deleteBulkDeletionFamilies(api, families);
    if (failedFamilies.length > 0) {
      const restoredChatIds = restoreBulkDeletionFamilies(failedFamilies, restoreChat);
      const { title, message } = describeBulkDeleteFailure(failedFamilies.length);
      Alert.alert(title, message);
      setSelectedChatIds(
        new Set(Array.from(selectedChatIds).filter((chatId) => restoredChatIds.has(chatId))),
      );
    } else {
      setSelectionMode(false);
      setSelectedChatIds(new Set());
    }
    if (selectedChatId && deletedChatIds.has(selectedChatId)) {
      onNewChat({ keepDrawerOpen: true });
    }
    return failedFamilies.length === 0;
  }, [
    api,
    chats,
    confirmSessionDeletion,
    onNewChat,
    removeChat,
    restoreChat,
    selectedChatId,
    selectedChatIds,
  ]);

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
    allSelectableChatsSelected,
    attentionCount: attentionModel.attentionCount,
    collapsedLaneKeys,
    enterSelectionMode,
    exitSelectionMode,
    folderOptions: attentionModel.folderOptions,
    folderPickerVisible,
    handleClearSearch,
    handleClose: onClose,
    handleDismissFolderPicker: () => setFolderPickerVisible(false),
    handleDeleteChat,
    handleDeleteSelectedChats,
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
    selectedChatCount,
    selectedChatId,
    selectedChatIds,
    selectedFolderKey,
    selectedFolderLabel: attentionModel.selectedFolderLabel,
    selectionMode,
    styles,
    theme,
    toggleAttentionSection,
    toggleChatSelection,
    toggleSelectAllChats,
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
