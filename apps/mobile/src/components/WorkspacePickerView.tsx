import { Ionicons } from '@expo/vector-icons';
import type { RefObject } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { FileSystemEntry, WorkspaceSummary } from '../api/types';
import { decorativeAccessibilityProps } from '../accessibility';
import type { AppTheme } from '../theme';
import { WorkspacePickerBrowser } from './WorkspacePickerBrowser';
import { WorkspacePickerFooter } from './WorkspacePickerFooter';
import type { WorkspacePickerStyles } from './workspacePickerStyles';
import { WorkspacePickerTopSection } from './WorkspacePickerTopSection';

export interface WorkspacePickerViewProps {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  screenFocusRef: RefObject<Text | null>;
  onClose: () => void;
  selectedPath: string | null;
  bridgeRoot: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onSelectPath: (path: string | null) => void;
  actionLabel: string | null;
  actionDescription: string | null;
  actionDisabled: boolean;
  onActionPress?: () => void;
  favoriteWorkspaces: WorkspaceSummary[];
  favoritePathSet: Set<string>;
  pendingSelectionPath: string | null;
  onBrowsePath: (path: string | null) => void;
  onToggleFavorite?: (path: string | null) => void;
  parentPath: string | null;
  loadingEntries: boolean;
  filteredEntries: FileSystemEntry[];
  normalizedSearch: string;
  currentFolderTitle: string;
  currentFolderPath: string | null;
  error: string | null;
  refreshError: string | null;
  truncationMessage: string | null;
  footerPath: string | null;
  footerTitle: string;
  footerSubtitle: string;
  footerIsFavorite: boolean;
}

export function WorkspacePickerView(props: WorkspacePickerViewProps) {
  return (
    <SafeAreaView style={props.styles.screen} edges={['top', 'bottom']}>
      <View style={props.styles.header}>
        <Pressable
          onPress={props.onClose}
          style={({ pressed }) => [props.styles.closeButton, pressed && props.styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-back"
            size={20}
            color={props.theme.colors.textSecondary}
          />
        </Pressable>
        <Text ref={props.screenFocusRef} accessibilityRole="header" style={props.styles.title}>
          Choose Workspace
        </Text>
        <View style={props.styles.headerSpacer} />
      </View>
      <View style={props.styles.body}>
        <WorkspacePickerTopSection
          {...props}
          hasVisibleEntries={props.filteredEntries.length > 0}
        />
        <WorkspacePickerBrowser
          styles={props.styles}
          theme={props.theme}
          entries={props.filteredEntries}
          loadingEntries={props.loadingEntries}
          normalizedSearch={props.normalizedSearch}
          favoritePathSet={props.favoritePathSet}
          onBrowsePath={props.onBrowsePath}
          onToggleFavorite={props.onToggleFavorite}
        />
        <WorkspacePickerFooter {...props} />
      </View>
    </SafeAreaView>
  );
}
