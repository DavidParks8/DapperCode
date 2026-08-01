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

export function WorkspacePickerTopSection(props: Props) {
  const { styles, theme } = props;
  return (
    <ScrollView
      style={styles.topContentScroll}
      contentContainerStyle={styles.topContentContainer}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.connectionRow}>
        <Text style={styles.connectionText} numberOfLines={1}>
          {props.bridgeRoot
            ? `Start folder: ${toPathBasename(props.bridgeRoot)}`
            : 'Computer folders'}
        </Text>
        <Pressable
          onPress={() => props.onSelectPath(null)}
          style={({ pressed }) => [
            styles.defaultButton,
            props.selectedPath === null && styles.defaultButtonSelected,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Use default workspace"
          accessibilityState={controlAccessibilityState({ selected: props.selectedPath === null })}
        >
          <Text
            style={[
              styles.defaultButtonText,
              props.selectedPath === null && styles.defaultButtonTextSelected,
            ]}
          >
            {props.selectedPath === null ? 'Default' : 'Use Default'}
          </Text>
        </Pressable>
      </View>

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

      {props.actionLabel && props.onActionPress ? (
        <Pressable
          onPress={props.onActionPress}
          disabled={props.actionDisabled}
          style={({ pressed }) => [
            styles.actionCard,
            props.actionDisabled && styles.buttonDisabled,
            pressed && !props.actionDisabled && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={props.actionLabel}
          accessibilityHint={props.actionDescription ?? 'Clones a repository into this folder'}
          accessibilityState={controlAccessibilityState({ disabled: props.actionDisabled })}
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
            <Text style={styles.actionTitle}>{props.actionLabel}</Text>
            <Text style={styles.actionSubtitle} numberOfLines={2}>
              {props.actionDescription ??
                'Clone into the selected or currently open folder and start the chat there.'}
            </Text>
          </View>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-forward"
            size={14}
            color={theme.colors.textMuted}
          />
        </Pressable>
      ) : null}

      {props.favoriteWorkspaces.length > 0 ? (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Pinned</Text>
          </View>
          <View style={styles.favoriteGrid}>
            {props.favoriteWorkspaces.map((workspace) => (
              <WorkspaceTile
                key={workspace.path}
                workspace={workspace}
                iconName="star"
                selected={workspace.path === props.pendingSelectionPath}
                onPress={() => props.onBrowsePath(workspace.path)}
                isPinned={props.favoritePathSet.has(workspace.path)}
                onPinAction={() => props.onToggleFavorite?.(workspace.path)}
              />
            ))}
          </View>
        </>
      ) : null}

      <View style={styles.breadcrumbRow}>
        <Pressable
          onPress={() => props.parentPath && props.onBrowsePath(props.parentPath)}
          disabled={!props.parentPath || (props.loadingEntries && !props.hasVisibleEntries)}
          style={({ pressed }) => [
            styles.upButton,
            (!props.parentPath || (props.loadingEntries && !props.hasVisibleEntries)) &&
              styles.buttonDisabled,
            pressed &&
              props.parentPath &&
              (!props.loadingEntries || props.hasVisibleEntries) &&
              styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Go to parent folder"
          accessibilityState={controlAccessibilityState({
            disabled: !props.parentPath || (props.loadingEntries && !props.hasVisibleEntries),
          })}
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
            {props.currentFolderTitle}
          </Text>
          <Text style={styles.currentFolderPath} numberOfLines={2} ellipsizeMode="middle">
            {props.currentFolderPath ?? 'Loading path'}
          </Text>
        </View>
      </View>
      {props.error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {props.error}
        </Text>
      ) : null}
      {props.refreshError ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {props.refreshError}
        </Text>
      ) : null}
      {props.truncationMessage ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {props.truncationMessage}
        </Text>
      ) : null}
    </ScrollView>
  );
}
