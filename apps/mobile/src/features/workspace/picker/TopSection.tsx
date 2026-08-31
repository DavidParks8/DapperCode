import { Ionicons } from '@expo/vector-icons';
import type { Ref, RefObject } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { WorkspaceSummary } from '@bridge/types/types';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import type { AppTheme } from '@shared/theme';
import { SwipeToDeleteRow } from '@shared/ui/SwipeToDeleteRow';
import { formatWorkspaceMeta, toPathBasename } from './helpers';
import { GroupedRow } from './Primitives';
import type { WorkspacePickerStyles } from './styles';

export interface WorkspacePickerListHeaderProps {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  screenFocusRef: RefObject<Text | null>;
  titleAnchorRef: Ref<View>;
  currentFolderTitle: string;
  onOpenPathMenu: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  bridgeRoot: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  favoriteWorkspaces: WorkspaceSummary[];
  pendingSelectionPath: string | null;
  onBrowsePath: (path: string | null) => void;
  onToggleFavorite?: (path: string | null) => void;
  folderCountLabel: string | null;
}

function WorkspacePickerLargeTitle({
  styles,
  theme,
  screenFocusRef,
  titleAnchorRef,
  currentFolderTitle,
  onOpenPathMenu,
}: Pick<
  WorkspacePickerListHeaderProps,
  'styles' | 'theme' | 'screenFocusRef' | 'titleAnchorRef' | 'currentFolderTitle' | 'onOpenPathMenu'
>) {
  return (
    <View ref={titleAnchorRef} collapsable={false} style={styles.largeTitleWrap}>
      <Pressable
        onPress={onOpenPathMenu}
        style={({ pressed }) => [styles.largeTitleButton, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${currentFolderTitle}, current folder`}
        accessibilityHint="Shows the folders this one sits inside"
      >
        <Text
          ref={screenFocusRef}
          accessibilityRole="header"
          style={styles.largeTitle}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {currentFolderTitle}
        </Text>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-down"
          size={17}
          color={theme.colors.textMuted}
          style={styles.largeTitleChevron}
        />
      </Pressable>
    </View>
  );
}

function WorkspacePickerSearchField({
  styles,
  theme,
  searchQuery,
  setSearchQuery,
  currentFolderTitle,
}: Pick<
  WorkspacePickerListHeaderProps,
  'styles' | 'theme' | 'searchQuery' | 'setSearchQuery' | 'currentFolderTitle'
>) {
  return (
    <View style={styles.searchField}>
      <Ionicons
        {...decorativeAccessibilityProps}
        name="search"
        size={16}
        color={theme.colors.textMuted}
      />
      <TextInput
        value={searchQuery}
        onChangeText={setSearchQuery}
        keyboardAppearance={theme.keyboardAppearance}
        placeholder={`Search ${currentFolderTitle}`}
        placeholderTextColor={theme.colors.textMuted}
        style={styles.searchInput}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        accessibilityLabel="Search folders"
      />
    </View>
  );
}

function WorkspacePickerDefaultGroup({
  styles,
  theme,
  bridgeRoot,
  selectedPath,
  onSelectPath,
}: Pick<
  WorkspacePickerListHeaderProps,
  'styles' | 'theme' | 'bridgeRoot' | 'selectedPath' | 'onSelectPath'
>) {
  const isDefault = selectedPath === null;
  return (
    <View style={styles.section}>
      <View style={styles.group}>
        <GroupedRow
          styles={styles}
          theme={theme}
          icon="home"
          title="Default workspace"
          subtitle={bridgeRoot ? toPathBasename(bridgeRoot) : 'Chosen by the bridge'}
          accessory="check"
          selected={isDefault}
          last
          accessibilityLabel="Use default workspace"
          onPress={() => onSelectPath(null)}
        />
      </View>
    </View>
  );
}

function WorkspacePickerPinnedGroup({
  styles,
  theme,
  favoriteWorkspaces,
  pendingSelectionPath,
  onBrowsePath,
  onToggleFavorite,
}: Pick<
  WorkspacePickerListHeaderProps,
  | 'styles'
  | 'theme'
  | 'favoriteWorkspaces'
  | 'pendingSelectionPath'
  | 'onBrowsePath'
  | 'onToggleFavorite'
>) {
  if (favoriteWorkspaces.length === 0) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Pinned</Text>
      <View style={styles.group}>
        {favoriteWorkspaces.map((workspace, index) => {
          const name = toPathBasename(workspace.path);
          const row = (
            <GroupedRow
              styles={styles}
              theme={theme}
              icon="star"
              title={name}
              subtitle={formatWorkspaceMeta(workspace)}
              accessory="chevron"
              selected={workspace.path === pendingSelectionPath}
              last={index === favoriteWorkspaces.length - 1}
              accessibilityLabel={`Open folder ${name}`}
              accessibilityHint={
                onToggleFavorite ? 'Swipe left to unpin this workspace' : undefined
              }
              onPress={() => onBrowsePath(workspace.path)}
            />
          );
          if (!onToggleFavorite) {
            return <View key={workspace.path}>{row}</View>;
          }
          return (
            <SwipeToDeleteRow
              key={workspace.path}
              onDelete={() => onToggleFavorite(workspace.path)}
              deleteAccessibilityLabel={`Unpin ${name}`}
              deleteLabel="Unpin"
              actionIconName="star-outline"
              actionBackgroundColor={theme.colors.accent}
              actionForegroundColor={theme.colors.accentText}
              actionAccessibilityHint="Removes this workspace from Pinned."
              contentBackgroundColor={theme.colors.bgItem}
            >
              {row}
            </SwipeToDeleteRow>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Everything above the folder list, rendered inside the list so it scrolls away like an iOS large
 * title instead of permanently eating the top third of the screen.
 */
export function WorkspacePickerListHeader(props: WorkspacePickerListHeaderProps) {
  const { styles } = props;
  return (
    <View style={styles.listHeader}>
      <WorkspacePickerLargeTitle
        styles={styles}
        theme={props.theme}
        screenFocusRef={props.screenFocusRef}
        titleAnchorRef={props.titleAnchorRef}
        currentFolderTitle={props.currentFolderTitle}
        onOpenPathMenu={props.onOpenPathMenu}
      />
      <WorkspacePickerSearchField
        styles={styles}
        theme={props.theme}
        searchQuery={props.searchQuery}
        setSearchQuery={props.setSearchQuery}
        currentFolderTitle={props.currentFolderTitle}
      />
      <WorkspacePickerDefaultGroup
        styles={styles}
        theme={props.theme}
        bridgeRoot={props.bridgeRoot}
        selectedPath={props.selectedPath}
        onSelectPath={props.onSelectPath}
      />
      <WorkspacePickerPinnedGroup
        styles={styles}
        theme={props.theme}
        favoriteWorkspaces={props.favoriteWorkspaces}
        pendingSelectionPath={props.pendingSelectionPath}
        onBrowsePath={props.onBrowsePath}
        onToggleFavorite={props.onToggleFavorite}
      />
      {props.folderCountLabel ? (
        <Text style={styles.sectionTitle}>{props.folderCountLabel}</Text>
      ) : null}
    </View>
  );
}
