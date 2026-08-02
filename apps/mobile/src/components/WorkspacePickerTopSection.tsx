import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { WorkspaceSummary } from '../api/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import type { AppTheme } from '../theme';
import { toPathBasename } from './workspacePickerHelpers';
import { WorkspaceTile } from './workspacePickerPrimitives';
import type { WorkspacePickerStyles } from './workspacePickerStyles';

interface Props {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  bridgeRoot: string | null;
  selectedPath: string | null;
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
  hasVisibleEntries: boolean;
  currentFolderTitle: string;
  currentFolderPath: string | null;
  error: string | null;
  refreshError: string | null;
  truncationMessage: string | null;
}

function WorkspacePickerConnectionRow({
  styles,
  bridgeRoot,
  selectedPath,
  onSelectPath,
}: Pick<Props, 'styles' | 'bridgeRoot' | 'selectedPath' | 'onSelectPath'>) {
  const isDefault = selectedPath === null;
  return (
    <View style={styles.connectionRow}>
      <Text style={styles.connectionText} numberOfLines={1}>
        {bridgeRoot ? `Start folder: ${toPathBasename(bridgeRoot)}` : 'Computer folders'}
      </Text>
      <Pressable
        onPress={() => onSelectPath(null)}
        style={({ pressed }) => [
          styles.defaultButton,
          isDefault && styles.defaultButtonSelected,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Use default workspace"
        accessibilityState={controlAccessibilityState({ selected: isDefault })}
      >
        <Text style={[styles.defaultButtonText, isDefault && styles.defaultButtonTextSelected]}>
          {isDefault ? 'Default' : 'Use Default'}
        </Text>
      </Pressable>
    </View>
  );
}

function WorkspacePickerActionCard({
  styles,
  theme,
  actionLabel,
  actionDescription,
  actionDisabled,
  onActionPress,
}: Pick<
  Props,
  'styles' | 'theme' | 'actionLabel' | 'actionDescription' | 'actionDisabled' | 'onActionPress'
>) {
  if (!actionLabel || !onActionPress) {
    return null;
  }
  const description =
    actionDescription ??
    'Clone into the selected or currently open folder and start the chat there.';
  return (
    <Pressable
      onPress={onActionPress}
      disabled={actionDisabled}
      style={({ pressed }) => [
        styles.actionCard,
        actionDisabled && styles.buttonDisabled,
        pressed && !actionDisabled && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={actionLabel}
      accessibilityHint={actionDescription ?? 'Clones a repository into this folder'}
      accessibilityState={controlAccessibilityState({ disabled: actionDisabled })}
    >
      <View style={styles.actionIconWrap}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="git-branch-outline"
          size={16}
          color={theme.colors.textSecondary}
        />
      </View>
      <View style={styles.actionCopy}>
        <Text style={styles.actionTitle}>{actionLabel}</Text>
        <Text style={styles.actionSubtitle} numberOfLines={2}>
          {description}
        </Text>
      </View>
      <Ionicons
        {...decorativeAccessibilityProps}
        name="chevron-forward"
        size={14}
        color={theme.colors.textMuted}
      />
    </Pressable>
  );
}

function WorkspacePickerFavoritesSection({
  styles,
  favoriteWorkspaces,
  pendingSelectionPath,
  favoritePathSet,
  onBrowsePath,
  onToggleFavorite,
}: Pick<
  Props,
  | 'styles'
  | 'favoriteWorkspaces'
  | 'pendingSelectionPath'
  | 'favoritePathSet'
  | 'onBrowsePath'
  | 'onToggleFavorite'
>) {
  if (favoriteWorkspaces.length === 0) {
    return null;
  }
  return (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Pinned</Text>
      </View>
      <View style={styles.favoriteGrid}>
        {favoriteWorkspaces.map((workspace) => (
          <WorkspaceTile
            key={workspace.path}
            workspace={workspace}
            iconName="star"
            selected={workspace.path === pendingSelectionPath}
            onPress={() => onBrowsePath(workspace.path)}
            isPinned={favoritePathSet.has(workspace.path)}
            onPinAction={() => onToggleFavorite?.(workspace.path)}
          />
        ))}
      </View>
    </>
  );
}

function WorkspacePickerBreadcrumbRow({
  styles,
  theme,
  parentPath,
  loadingEntries,
  hasVisibleEntries,
  onBrowsePath,
  currentFolderTitle,
  currentFolderPath,
}: Pick<
  Props,
  | 'styles'
  | 'theme'
  | 'parentPath'
  | 'loadingEntries'
  | 'hasVisibleEntries'
  | 'onBrowsePath'
  | 'currentFolderTitle'
  | 'currentFolderPath'
>) {
  const upDisabled = !parentPath || (loadingEntries && !hasVisibleEntries);
  return (
    <View style={styles.breadcrumbRow}>
      <Pressable
        onPress={() => parentPath && onBrowsePath(parentPath)}
        disabled={upDisabled}
        style={({ pressed }) => [
          styles.upButton,
          upDisabled && styles.buttonDisabled,
          pressed && !upDisabled && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Go to parent folder"
        accessibilityState={controlAccessibilityState({ disabled: upDisabled })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="return-up-back"
          size={14}
          color={theme.colors.textSecondary}
        />
        <Text style={styles.upButtonText}>Up</Text>
      </Pressable>
      <View style={styles.currentFolderChip}>
        <Text style={styles.currentFolderTitle} numberOfLines={1}>
          {currentFolderTitle}
        </Text>
        <Text style={styles.currentFolderPath} numberOfLines={2} ellipsizeMode="middle">
          {currentFolderPath ?? 'Loading path'}
        </Text>
      </View>
    </View>
  );
}

function WorkspacePickerStatusMessages({
  styles,
  error,
  refreshError,
  truncationMessage,
}: Pick<Props, 'styles' | 'error' | 'refreshError' | 'truncationMessage'>) {
  return (
    <>
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {error}
        </Text>
      ) : null}
      {refreshError ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {refreshError}
        </Text>
      ) : null}
      {truncationMessage ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {truncationMessage}
        </Text>
      ) : null}
    </>
  );
}

export function WorkspacePickerTopSection(props: Props) {
  const { styles, theme } = props;
  return (
    <ScrollView
      style={styles.topContentScroll}
      contentContainerStyle={styles.topContentContainer}
      showsVerticalScrollIndicator={false}
    >
      <WorkspacePickerConnectionRow
        styles={styles}
        bridgeRoot={props.bridgeRoot}
        selectedPath={props.selectedPath}
        onSelectPath={props.onSelectPath}
      />

      <View style={styles.searchField}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="search"
          size={16}
          color={theme.colors.textMuted}
        />
        <TextInput
          value={props.searchQuery}
          onChangeText={props.setSearchQuery}
          keyboardAppearance={theme.keyboardAppearance}
          placeholder="Search folders"
          placeholderTextColor={theme.colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search folders"
        />
      </View>

      <WorkspacePickerActionCard
        styles={styles}
        theme={theme}
        actionLabel={props.actionLabel}
        actionDescription={props.actionDescription}
        actionDisabled={props.actionDisabled}
        onActionPress={props.onActionPress}
      />

      <WorkspacePickerFavoritesSection
        styles={styles}
        favoriteWorkspaces={props.favoriteWorkspaces}
        pendingSelectionPath={props.pendingSelectionPath}
        favoritePathSet={props.favoritePathSet}
        onBrowsePath={props.onBrowsePath}
        onToggleFavorite={props.onToggleFavorite}
      />

      <WorkspacePickerBreadcrumbRow
        styles={styles}
        theme={theme}
        parentPath={props.parentPath}
        loadingEntries={props.loadingEntries}
        hasVisibleEntries={props.hasVisibleEntries}
        onBrowsePath={props.onBrowsePath}
        currentFolderTitle={props.currentFolderTitle}
        currentFolderPath={props.currentFolderPath}
      />
      <WorkspacePickerStatusMessages
        styles={styles}
        error={props.error}
        refreshError={props.refreshError}
        truncationMessage={props.truncationMessage}
      />
    </ScrollView>
  );
}
