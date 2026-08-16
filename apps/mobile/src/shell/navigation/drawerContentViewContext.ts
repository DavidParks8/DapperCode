import { createContext, useContext, type RefObject } from 'react';
import type { AppTheme } from '@shared/theme';
import type {
  DrawerAttentionLane,
  DrawerAttentionSection,
  DrawerFolderOption,
} from '@shell/navigation/drawerAttention';
import type { DrawerContentStyles } from '@shell/navigation/drawerContentStyles';
import type { DrawerScreen } from '@shell/navigation/drawerContentTypes';

export interface DrawerContentViewModel {
  allSelectableChatsSelected: boolean;
  attentionCount: number;
  collapsedLaneKeys: Set<DrawerAttentionLane>;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
  folderOptions: DrawerFolderOption[];
  folderPickerVisible: boolean;
  handleClearSearch: () => void;
  handleDismissFolderPicker: () => void;
  handleClose?: () => void;
  handleDeleteChat: (chatId: string) => Promise<boolean>;
  handleDeleteSelectedChats: () => Promise<boolean>;
  handleNavigate: (screen: DrawerScreen) => void;
  handleNewChat: () => void;
  handleOpenConnection: () => void;
  handleOpenFolderPicker: () => void;
  handleSearchQueryChange: (value: string) => void;
  handleSelectChat: (chatId: string) => void;
  handleSelectFolder: (folderKey: string | null) => void;
  hasAnySessions: boolean;
  isSearching: boolean;
  loading: boolean;
  loadingOlderChats: boolean;
  noticeMessages: string[];
  recentCount: number;
  refreshing: boolean;
  refreshDrawer: () => Promise<void>;
  resolvedEmptyHint: string;
  resolvedEmptyTitle: string;
  retryDeepChatListRef: RefObject<() => Promise<void>>;
  searchQuery: string;
  searchResultCount: number;
  selectedChatCount: number;
  selectedChatId: string | null;
  selectedChatIds: ReadonlySet<string>;
  selectedFolderKey: string | null;
  selectedFolderLabel: string;
  selectionMode: boolean;
  styles: DrawerContentStyles;
  theme: AppTheme;
  toggleAttentionSection: (lane: DrawerAttentionLane) => void;
  toggleChatSelection: (chatId: string) => void;
  toggleSelectAllChats: () => void;
  totalChatCount: number;
  visibleAttentionSections: DrawerAttentionSection[];
  visibleChatCount: number;
  workingCount: number;
  wsConnected: boolean;
}

export const DrawerContentViewContext = createContext<DrawerContentViewModel | null>(null);

export function useDrawerContentViewModel(): DrawerContentViewModel {
  const value = useContext(DrawerContentViewContext);
  if (!value) {
    throw new Error('DrawerContentView requires DrawerContentViewContext');
  }
  return value;
}
