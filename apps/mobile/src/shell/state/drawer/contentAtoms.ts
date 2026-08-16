import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { Keyboard } from 'react-native';

import type { ChatSummary, PendingApproval, PendingUserInputRequest } from '@bridge/types/types';
import { feedback } from '@shared/feedback';
import {
  buildDrawerAttentionModel,
  type DrawerAttentionLane,
  type DrawerFolderOption,
} from '@shell/navigation/drawerAttention';
import {
  filterDrawerAttentionSections,
  normalizeWorkspaceChatLimit,
} from '@shell/navigation/drawerContentHelpers';
import {
  areAllChatIdsSelected,
  collectSelectableChatIds,
  pruneSelectedChatIds,
  toggleSelectedChatId,
} from '@shell/navigation/drawerSelection';
import type { DrawerRunIndicatorMap } from '@shell/navigation/drawerRuntimeIndicators';
import { workspaceChatLimitAtom } from '@shell/state/appState/settings';
import { activeBridgeCapabilitiesResourceAtom } from '@shell/state/bridge/capabilities';
import { selectedChatIdAtom } from '@shell/state/chat/atoms';

interface DrawerChatState {
  profileId: string | null;
  chats: ChatSummary[];
}

interface CreateDrawerContentAtomsOptions {
  profileId: string | null;
  wsConnected: boolean;
}

function areFolderOptionsEqual(
  previous: DrawerFolderOption[],
  next: DrawerFolderOption[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((option, index) => {
      const nextOption = next[index];
      return (
        nextOption !== undefined &&
        option.key === nextOption.key &&
        option.label === nextOption.label &&
        option.subtitle === nextOption.subtitle &&
        option.itemCount === nextOption.itemCount
      );
    })
  );
}

export function createDrawerContentAtoms({
  profileId,
  wsConnected: initiallyConnected,
}: CreateDrawerContentAtomsOptions) {
  const chatStateAtom = atom<DrawerChatState>({ profileId, chats: [] });
  const runIndicatorsByThreadAtom = atom<DrawerRunIndicatorMap>({});
  const loadingAtom = atom(true);
  const loadingOlderChatsAtom = atom(false);
  const deepHistoryDiagnosticsAtom = atom<string[]>([]);
  const hydrationDiagnosticsAtom = atom<string[]>([]);
  const refreshingAtom = atom(false);
  const wsConnectedAtom = atom(initiallyConnected);

  const pendingApprovalsAtom = atom<PendingApproval[]>([]);
  const pendingUserInputsAtom = atom<PendingUserInputRequest[]>([]);
  const attentionRequestErrorAtom = atom<string | null>(null);
  const refreshingAttentionRequestsAtom = atom(false);

  const selectedFolderKeyAtom = atom<string | null>(null);
  const collapsedLaneKeysAtom = atom<ReadonlySet<DrawerAttentionLane>>(
    new Set<DrawerAttentionLane>(),
  );
  const folderPickerVisibleAtom = atom(false);
  const searchQueryAtom = atom('');
  const selectionModeAtom = atom(false);
  const selectedChatIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

  const chatsAtom = atom((get) => {
    const state = get(chatStateAtom);
    return state.profileId === profileId ? state.chats : [];
  });
  const priorityThreadIdsAtom = atom((get) =>
    Array.from(
      new Set([
        ...get(pendingApprovalsAtom).map((approval) => approval.threadId),
        ...get(pendingUserInputsAtom).map((request) => request.threadId),
      ]),
    ),
  );
  const partialHistoryDiagnosticsAtom = atom((get) =>
    Array.from(new Set([...get(deepHistoryDiagnosticsAtom), ...get(hydrationDiagnosticsAtom)])),
  );
  const attentionModelAtom = atom((get) =>
    buildDrawerAttentionModel({
      chats: get(chatsAtom),
      agents: get(activeBridgeCapabilitiesResourceAtom).value?.agents ?? [],
      runIndicatorsByThread: get(runIndicatorsByThreadAtom),
      pendingApprovals: get(pendingApprovalsAtom),
      pendingUserInputs: get(pendingUserInputsAtom),
      selectedFolderKey: get(selectedFolderKeyAtom),
      workspaceChatLimit: normalizeWorkspaceChatLimit(get(workspaceChatLimitAtom)),
    }),
  );
  const attentionCountAtom = atom((get) => get(attentionModelAtom).attentionCount);
  const folderOptionsAtom = selectAtom(
    attentionModelAtom,
    (model) => model.folderOptions,
    areFolderOptionsEqual,
  );
  const recentCountAtom = atom((get) => get(attentionModelAtom).recentCount);
  const selectedFolderLabelAtom = atom((get) => get(attentionModelAtom).selectedFolderLabel);
  const totalChatCountAtom = atom((get) => get(attentionModelAtom).sessionCount);
  const workingCountAtom = atom((get) => get(attentionModelAtom).workingCount);
  const hasAnySessionsAtom = atom((get) => get(chatsAtom).length > 0);
  const trimmedSearchQueryAtom = atom((get) => get(searchQueryAtom).trim());
  const isSearchingAtom = atom((get) => get(trimmedSearchQueryAtom).length > 0);
  const visibleAttentionSectionsAtom = atom((get) => {
    const sections = get(attentionModelAtom).sections;
    if (get(isSearchingAtom)) {
      return filterDrawerAttentionSections(sections, get(trimmedSearchQueryAtom));
    }
    const collapsedLaneKeys = get(collapsedLaneKeysAtom);
    return sections.map((section) =>
      collapsedLaneKeys.has(section.key)
        ? {
            ...section,
            data: [],
          }
        : section,
    );
  });
  const searchResultCountAtom = atom((get) =>
    get(visibleAttentionSectionsAtom).reduce((total, section) => total + section.data.length, 0),
  );
  const selectableChatIdsAtom = atom((get) =>
    collectSelectableChatIds(get(visibleAttentionSectionsAtom)),
  );
  const allSelectableChatsSelectedAtom = atom((get) =>
    areAllChatIdsSelected(get(selectableChatIdsAtom), get(selectedChatIdsAtom)),
  );
  const selectedChatCountAtom = atom((get) => get(selectedChatIdsAtom).size);
  const noticeMessagesAtom = atom((get) => {
    const agentMetadataError = get(activeBridgeCapabilitiesResourceAtom).error
      ? 'Could not refresh agent names.'
      : null;
    return [
      get(attentionRequestErrorAtom),
      agentMetadataError,
      ...get(partialHistoryDiagnosticsAtom),
    ].filter((message): message is string => Boolean(message));
  });
  const resolvedEmptyTitleAtom = atom((get) => {
    const chats = get(chatsAtom);
    if (chats.length === 0) {
      return 'No sessions yet';
    }
    const model = get(attentionModelAtom);
    return get(selectedFolderKeyAtom)
      ? `No sessions in ${model.selectedFolderLabel}`
      : 'No sessions to show';
  });
  const resolvedEmptyHintAtom = atom((get) =>
    get(chatsAtom).length === 0
      ? 'Start a new chat and it will appear here with live activity.'
      : 'Choose another folder to see its sessions.',
  );
  const searchAnnouncementMessageAtom = atom((get) => {
    if (!get(isSearchingAtom)) {
      return null;
    }
    const count = get(searchResultCountAtom);
    const query = get(trimmedSearchQueryAtom);
    return count === 0
      ? `No sessions match "${query}"`
      : `${String(count)} ${count === 1 ? 'session matches' : 'sessions match'} "${query}"`;
  });

  const headerStateAtom = atom((get) => {
    const isSearching = get(isSearchingAtom);
    return {
      attentionCount: get(attentionCountAtom),
      folderPickerVisible: get(folderPickerVisibleAtom),
      isSearching,
      recentCount: get(recentCountAtom),
      searchQuery: get(searchQueryAtom),
      searchResultCount: isSearching ? get(searchResultCountAtom) : 0,
      selectedChatCount: get(selectedChatCountAtom),
      selectedFolderLabel: get(selectedFolderLabelAtom),
      selectionMode: get(selectionModeAtom),
      workingCount: get(workingCountAtom),
    };
  });
  const selectionButtonStateAtom = atom((get) => ({
    hasAnySessions: get(hasAnySessionsAtom),
    selectionMode: get(selectionModeAtom),
  }));
  const selectionToolbarStateAtom = atom((get) => ({
    allSelectableChatsSelected: get(allSelectableChatsSelectedAtom),
    selectedChatCount: get(selectedChatCountAtom),
  }));
  const footerStateAtom = atom((get) => ({
    totalChatCount: get(totalChatCountAtom),
    wsConnected: get(wsConnectedAtom),
  }));
  const folderPickerStateAtom = atom((get) => ({
    folderOptions: get(folderOptionsAtom),
    selectedFolderKey: get(selectedFolderKeyAtom),
    visible: get(folderPickerVisibleAtom),
  }));
  const listStateAtom = atom((get) => ({
    collapsedLaneKeys: get(collapsedLaneKeysAtom),
    isSearching: get(isSearchingAtom),
    loading: get(loadingAtom),
    loadingOlderChats: get(loadingOlderChatsAtom),
    noticeMessages: get(noticeMessagesAtom),
    refreshing: get(refreshingAtom) || get(refreshingAttentionRequestsAtom),
    resolvedEmptyHint: get(resolvedEmptyHintAtom),
    resolvedEmptyTitle: get(resolvedEmptyTitleAtom),
    searchQuery: get(searchQueryAtom),
    selectedChatId: get(selectedChatIdAtom),
    selectedChatIds: get(selectedChatIdsAtom),
    selectionMode: get(selectionModeAtom),
    visibleAttentionSections: get(visibleAttentionSectionsAtom),
    wsConnected: get(wsConnectedAtom),
  }));

  const setSearchQueryAtom = atom(null, (_get, set, value: string): void => {
    set(searchQueryAtom, value);
  });
  const clearSearchAtom = atom(null, (_get, set): void => {
    set(searchQueryAtom, '');
    void feedback.selection();
  });
  const openFolderPickerAtom = atom(null, (_get, set): void => {
    set(folderPickerVisibleAtom, true);
  });
  const dismissFolderPickerAtom = atom(null, (_get, set): void => {
    set(folderPickerVisibleAtom, false);
  });
  const selectFolderAtom = atom(null, (_get, set, folderKey: string | null): void => {
    set(selectedFolderKeyAtom, folderKey);
    set(folderPickerVisibleAtom, false);
  });
  const toggleAttentionSectionAtom = atom(null, (get, set, lane: DrawerAttentionLane): void => {
    const next = new Set(get(collapsedLaneKeysAtom));
    if (next.has(lane)) {
      next.delete(lane);
    } else {
      next.add(lane);
    }
    set(collapsedLaneKeysAtom, next);
  });
  const enterSelectionModeAtom = atom(null, (_get, set): void => {
    Keyboard.dismiss();
    set(collapsedLaneKeysAtom, new Set());
    set(selectedChatIdsAtom, new Set());
    set(selectionModeAtom, true);
    void feedback.selection();
  });
  const resetSelectionAtom = atom(null, (_get, set): void => {
    set(selectionModeAtom, false);
    set(selectedChatIdsAtom, new Set());
  });
  const exitSelectionModeAtom = atom(null, (_get, set): void => {
    set(resetSelectionAtom);
    void feedback.selection();
  });
  const toggleChatSelectionAtom = atom(null, (get, set, chatId: string): void => {
    void feedback.selection();
    set(selectedChatIdsAtom, toggleSelectedChatId(get(selectedChatIdsAtom), chatId));
  });
  const toggleSelectAllChatsAtom = atom(null, (get, set): void => {
    void feedback.selection();
    const selectableChatIds = get(selectableChatIdsAtom);
    set(
      selectedChatIdsAtom,
      areAllChatIdsSelected(selectableChatIds, get(selectedChatIdsAtom))
        ? new Set()
        : new Set(selectableChatIds),
    );
  });
  const pruneSelectedChatIdsAtom = atom(null, (get, set): void => {
    const previous = get(selectedChatIdsAtom);
    if (previous.size === 0) {
      return;
    }
    set(
      selectedChatIdsAtom,
      pruneSelectedChatIds(
        previous,
        get(chatsAtom).map((chat) => chat.id),
      ),
    );
  });
  const resetCollapsedLanesAtom = atom(null, (_get, set): void => {
    set(collapsedLaneKeysAtom, new Set());
  });

  return {
    allSelectableChatsSelectedAtom,
    attentionModelAtom,
    attentionRequestErrorAtom,
    chatStateAtom,
    chatsAtom,
    clearSearchAtom,
    collapsedLaneKeysAtom,
    deepHistoryDiagnosticsAtom,
    dismissFolderPickerAtom,
    enterSelectionModeAtom,
    exitSelectionModeAtom,
    folderOptionsAtom,
    folderPickerStateAtom,
    folderPickerVisibleAtom,
    footerStateAtom,
    headerStateAtom,
    hydrationDiagnosticsAtom,
    isSearchingAtom,
    listStateAtom,
    loadingAtom,
    loadingOlderChatsAtom,
    openFolderPickerAtom,
    partialHistoryDiagnosticsAtom,
    pendingApprovalsAtom,
    pendingUserInputsAtom,
    priorityThreadIdsAtom,
    pruneSelectedChatIdsAtom,
    refreshingAtom,
    refreshingAttentionRequestsAtom,
    resetCollapsedLanesAtom,
    resetSelectionAtom,
    runIndicatorsByThreadAtom,
    searchAnnouncementMessageAtom,
    searchQueryAtom,
    searchResultCountAtom,
    selectFolderAtom,
    selectedChatCountAtom,
    selectedChatIdsAtom,
    selectedFolderKeyAtom,
    selectionButtonStateAtom,
    selectionModeAtom,
    selectionToolbarStateAtom,
    setSearchQueryAtom,
    toggleAttentionSectionAtom,
    toggleChatSelectionAtom,
    toggleSelectAllChatsAtom,
    visibleAttentionSectionsAtom,
    wsConnectedAtom,
  };
}

export type DrawerContentAtoms = ReturnType<typeof createDrawerContentAtoms>;
