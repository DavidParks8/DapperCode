import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { Alert, AppState, Keyboard } from 'react-native';
import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { confirmAction } from '@shared/ui/confirm';
import { feedback } from '@shared/feedback';
import { confirmSessionDeletionAtom } from '@shell/state/appState/settings';
import { useBridgeApi, useBridgeWs } from '@shell/state/bridge/hooks';
import { useBridgeCapabilitiesResource } from '@shell/state/bridge/capabilities';
import { selectedChatIdAtom } from '@shell/state/chat/atoms';
import {
  createDrawerContentAtoms,
  type DrawerContentAtoms,
} from '@shell/state/drawer/contentAtoms';
import {
  navigateAtom,
  openBridgeConnectionAtom,
  selectChatAtom,
  startNewChatAtom,
} from '@shell/navigation/actions';
import {
  buildBulkDeletionPlan,
  buildChatDeletionFamily,
  deleteChatFamilies,
  deleteChatFamily,
  restoreChatFamilies,
} from '@shell/navigation/chatDeletion';
import type { DrawerContentProps, DrawerScreen } from '@shell/navigation/drawerContentTypes';
import { DrawerContentView } from '@shell/navigation/DrawerContentView';
import {
  DrawerContentAtomsContext,
  useDrawerContentAtoms,
} from '@shell/navigation/drawerContentViewContext';
import { describeBulkDeleteFailure, describeBulkDeletion } from '@shell/navigation/drawerSelection';
import { useDrawerAttentionRequests } from '@shell/navigation/useDrawerAttentionRequests';
import { useDrawerChatLoading } from '@shell/navigation/useDrawerChatLoading';

const DRAWER_EVENT_REFRESH_DEBOUNCE_MS = 250;

interface DrawerContentStateEffectsProps {
  active: boolean;
  refreshAttentionRequests: () => Promise<void>;
  resetPollTimer: (delay?: number, forceRefresh?: boolean) => void;
}

function useProfileDrawerContentAtoms(
  profileId: string | null,
  wsConnected: boolean,
): DrawerContentAtoms {
  const scopeRef = useRef<{ atoms: DrawerContentAtoms; profileId: string | null } | null>(null);
  if (!scopeRef.current || scopeRef.current.profileId !== profileId) {
    scopeRef.current = {
      atoms: createDrawerContentAtoms({ profileId, wsConnected }),
      profileId,
    };
  }
  return scopeRef.current.atoms;
}

function DrawerContentStateEffects({
  active,
  refreshAttentionRequests,
  resetPollTimer,
}: DrawerContentStateEffectsProps) {
  const atoms = useDrawerContentAtoms();
  const chats = useAtomValue(atoms.chatsAtom);
  const folderOptions = useAtomValue(atoms.folderOptionsAtom);
  const searchAnnouncementMessage = useAtomValue(atoms.searchAnnouncementMessageAtom);
  const selectedFolderKey = useAtomValue(atoms.selectedFolderKeyAtom);
  const pruneSelectedChatIds = useSetAtom(atoms.pruneSelectedChatIdsAtom);
  const resetCollapsedLanes = useSetAtom(atoms.resetCollapsedLanesAtom);
  const resetSelection = useSetAtom(atoms.resetSelectionAtom);
  const setSelectedFolderKey = useSetAtom(atoms.selectedFolderKeyAtom);
  const [debouncedSearchAnnouncement, setDebouncedSearchAnnouncement] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (selectedFolderKey && !folderOptions.some((option) => option.key === selectedFolderKey)) {
      setSelectedFolderKey(null);
    }
  }, [folderOptions, selectedFolderKey, setSelectedFolderKey]);

  useEffect(() => {
    pruneSelectedChatIds();
  }, [chats, pruneSelectedChatIds]);

  useEffect(() => {
    if (!active) {
      resetSelection();
    }
  }, [active, resetSelection]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        resetCollapsedLanes();
        resetPollTimer(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
        void refreshAttentionRequests();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [active, refreshAttentionRequests, resetCollapsedLanes, resetPollTimer]);

  useEffect(() => {
    if (!searchAnnouncementMessage) {
      setDebouncedSearchAnnouncement(null);
      return;
    }
    const timeout = setTimeout(() => {
      setDebouncedSearchAnnouncement(searchAnnouncementMessage);
    }, 400);
    return () => clearTimeout(timeout);
  }, [searchAnnouncementMessage]);

  useAccessibilityAnnouncement(debouncedSearchAnnouncement);
  return null;
}

export const DrawerContent = memo(function DrawerContentComponent({
  active,
  onClose,
}: DrawerContentProps) {
  const api = useBridgeApi();
  const ws = useBridgeWs();
  const store = useStore();
  const contentAtoms = useProfileDrawerContentAtoms(api.profileId, ws.isConnected);
  const priorityThreadIds = useAtomValue(contentAtoms.priorityThreadIdsAtom);
  const onSelectChat = useSetAtom(selectChatAtom);
  const onNewChat = useSetAtom(startNewChatAtom);
  const onNavigate = useSetAtom(navigateAtom);
  const onOpenConnection = useSetAtom(openBridgeConnectionAtom);
  const { refreshAttentionRequests } = useDrawerAttentionRequests(api, ws, active, contentAtoms);
  const {
    loadChats,
    removeChat,
    restoreChat,
    retryDeepChatListRef,
    cancelChatListStream,
    resetPollTimer,
  } = useDrawerChatLoading(api, ws, active, priorityThreadIds, api.profileId, contentAtoms);
  const { refresh: refreshAgentMetadata } = useBridgeCapabilitiesResource();

  const handleOpenConnection = useCallback(() => {
    cancelChatListStream();
    onOpenConnection();
  }, [cancelChatListStream, onOpenConnection]);

  const refreshDrawer = useCallback(async () => {
    await Promise.all([loadChats(true, true), refreshAttentionRequests(), refreshAgentMetadata()]);
  }, [loadChats, refreshAgentMetadata, refreshAttentionRequests]);

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
      const chats = store.get(contentAtoms.chatsAtom);
      const family = buildChatDeletionFamily(chats, chatId);
      if (store.get(confirmSessionDeletionAtom)) {
        const chat = chats.find((entry) => entry.id === chatId);
        const descendantCount = family.chats.filter((entry) => entry.id !== chatId).length;
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
      for (const affectedChatId of family.chatIds) {
        removeChat(affectedChatId);
      }
      const deletedChatIds = await deleteChatFamily(api, family);
      if (!deletedChatIds) {
        restoreChatFamilies([family], restoreChat);
        Alert.alert(
          'Could not delete session',
          'The session was restored. Check the bridge connection and try again.',
        );
        return false;
      }
      const selectedChatId = store.get(selectedChatIdAtom);
      if (selectedChatId && family.chatIds.has(selectedChatId)) {
        onNewChat({ keepDrawerOpen: true });
      }
      return true;
    },
    [api, contentAtoms, onNewChat, removeChat, restoreChat, store],
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
    const selectedChatIds = store.get(contentAtoms.selectedChatIdsAtom);
    if (selectedChatIds.size === 0) {
      return false;
    }
    const chats = store.get(contentAtoms.chatsAtom);
    const { families, affectedChatIds } = buildBulkDeletionPlan(chats, selectedChatIds);
    if (families.length === 0) {
      store.set(contentAtoms.resetSelectionAtom);
      return false;
    }
    if (store.get(confirmSessionDeletionAtom)) {
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
    const { failedFamilies, deletedChatIds } = await deleteChatFamilies(api, families);
    if (failedFamilies.length > 0) {
      const restoredChatIds = restoreChatFamilies(failedFamilies, restoreChat);
      const { title, message } = describeBulkDeleteFailure(failedFamilies.length);
      Alert.alert(title, message);
      store.set(
        contentAtoms.selectedChatIdsAtom,
        new Set(Array.from(selectedChatIds).filter((chatId) => restoredChatIds.has(chatId))),
      );
    } else {
      store.set(contentAtoms.resetSelectionAtom);
    }
    const selectedChatId = store.get(selectedChatIdAtom);
    if (selectedChatId && deletedChatIds.has(selectedChatId)) {
      onNewChat({ keepDrawerOpen: true });
    }
    return failedFamilies.length === 0;
  }, [api, contentAtoms, onNewChat, removeChat, restoreChat, store]);
  return (
    <DrawerContentAtomsContext.Provider value={contentAtoms}>
      <DrawerContentStateEffects
        active={active}
        refreshAttentionRequests={refreshAttentionRequests}
        resetPollTimer={resetPollTimer}
      />
      <DrawerContentView
        handleClose={onClose}
        handleDeleteChat={handleDeleteChat}
        handleDeleteSelectedChats={handleDeleteSelectedChats}
        handleNavigate={handleNavigate}
        handleNewChat={handleNewChat}
        handleOpenConnection={handleOpenConnection}
        handleSelectChat={handleSelectChat}
        refreshDrawer={refreshDrawer}
        retryDeepChatListRef={retryDeepChatListRef}
      />
    </DrawerContentAtomsContext.Provider>
  );
});
