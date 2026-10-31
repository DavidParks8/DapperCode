import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import type { AppTheme } from '@shared/theme';
import type { SceneToolbarItem } from '@shell/layout/SceneToolbar';
import { fileName, parentFilePath, type WorkspaceFilesController } from './controller';
import type { WorkspaceFilesStyles } from './styles';

export interface FilesHeaderActions {
  back: () => void;
  newFile: () => void;
}

function workspaceName(cwd: string | null): string {
  return cwd?.split('/').filter(Boolean).pop() ?? 'Files';
}

/** Title and subtitle: the open file, the current folder, or the workspace root. */
export function filesTitles(
  controller: WorkspaceFilesController,
  cwd: string | null,
): { title: string; subtitle: string; backLabel: string } {
  const root = workspaceName(cwd);
  const { file, directory } = controller;
  if (file) {
    const subtitle = controller.dirty
      ? 'Edited'
      : file.truncated
        ? 'Read-only preview'
        : parentFilePath(file.path) || root;
    return { title: fileName(file.path), subtitle, backLabel: 'Close file' };
  }
  if (directory) {
    const parent = parentFilePath(directory);
    return {
      title: fileName(directory),
      subtitle: parent ? `${root}/${parent}` : root,
      backLabel: 'Up one folder',
    };
  }
  return { title: root, subtitle: 'Workspace files', backLabel: 'Back' };
}

/** Items for the vertical scene toolbar used on wide layouts. */
export function filesToolbarItems(
  controller: WorkspaceFilesController,
  enabled: boolean,
  actions: FilesHeaderActions,
): SceneToolbarItem[] {
  const back: SceneToolbarItem = {
    key: 'back',
    icon: 'chevron-back',
    label: 'Back',
    onPress: actions.back,
    group: 'navigation',
  };
  if (!enabled) {
    return [back];
  }
  if (controller.file) {
    return [
      back,
      {
        key: 'save',
        icon: 'save-outline',
        label: 'Save',
        onPress: () => void controller.save(),
        group: 'action',
        disabled: !controller.dirty || controller.saving,
      },
    ];
  }
  return [
    back,
    { key: 'new', icon: 'add', label: 'New file', onPress: actions.newFile, group: 'action' },
    {
      key: 'refresh',
      icon: 'refresh',
      label: 'Refresh files',
      onPress: () => void controller.refresh(),
      group: 'action',
      disabled: controller.loading,
    },
  ];
}

function HeaderButton({
  icon,
  label,
  onPress,
  disabled,
  theme,
  styles,
  testID,
}: {
  icon: SceneToolbarItem['icon'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  theme: AppTheme;
  styles: WorkspaceFilesStyles;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={styles.headerButton}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={controlAccessibilityState({ disabled: Boolean(disabled) })}
      testID={testID}
    >
      <Ionicons
        {...decorativeAccessibilityProps}
        name={icon}
        size={22}
        color={disabled ? theme.colors.textMuted : theme.colors.accent}
      />
    </Pressable>
  );
}

function SaveButton({
  controller,
  styles,
}: {
  controller: WorkspaceFilesController;
  styles: WorkspaceFilesStyles;
}) {
  const disabled = !controller.dirty || controller.saving;
  return (
    <Pressable
      onPress={() => void controller.save()}
      disabled={disabled}
      hitSlop={8}
      style={styles.headerButton}
      accessibilityRole="button"
      accessibilityState={controlAccessibilityState({ disabled, busy: controller.saving })}
      testID="files-save"
    >
      {controller.saving ? (
        <ActivityIndicator size="small" />
      ) : (
        <Text style={[styles.headerTextButton, disabled && styles.headerTextButtonDisabled]}>
          Save
        </Text>
      )}
    </Pressable>
  );
}

function HeaderActions({
  controller,
  styles,
  theme,
  actions,
}: {
  controller: WorkspaceFilesController;
  styles: WorkspaceFilesStyles;
  theme: AppTheme;
  actions: FilesHeaderActions;
}) {
  if (controller.file) {
    return <SaveButton controller={controller} styles={styles} />;
  }
  return (
    <>
      <HeaderButton
        icon="refresh"
        label="Refresh files"
        onPress={() => void controller.refresh()}
        disabled={controller.loading}
        theme={theme}
        styles={styles}
      />
      <HeaderButton
        icon="add"
        label="New file"
        onPress={actions.newFile}
        theme={theme}
        styles={styles}
        testID="files-new"
      />
    </>
  );
}

/** The inline header: back, title with a dirty dot, and the actions for the current mode. */
export function FilesHeader({
  controller,
  cwd,
  styles,
  theme,
  inline,
  enabled,
  actions,
}: {
  controller: WorkspaceFilesController;
  cwd: string | null;
  styles: WorkspaceFilesStyles;
  theme: AppTheme;
  /** False when a vertical scene toolbar shows the buttons instead. */
  inline: boolean;
  enabled: boolean;
  actions: FilesHeaderActions;
}) {
  const { title, subtitle, backLabel } = filesTitles(controller, cwd);
  return (
    <View style={styles.header}>
      {inline ? (
        <HeaderButton
          icon="chevron-back"
          label={backLabel}
          onPress={actions.back}
          theme={theme}
          styles={styles}
          testID="files-back"
        />
      ) : null}
      <View style={styles.headerTitles}>
        <View style={styles.titleRow}>
          <Text
            accessibilityRole="header"
            style={styles.headerTitle}
            numberOfLines={1}
            testID="files-title"
          >
            {title}
          </Text>
          {controller.dirty ? (
            <View
              style={styles.dirtyDot}
              accessible
              accessibilityLabel="Unsaved edits"
              testID="files-dirty-indicator"
            />
          ) : null}
        </View>
        <Text style={styles.headerSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {inline && enabled ? (
        <HeaderActions controller={controller} styles={styles} theme={theme} actions={actions} />
      ) : null}
    </View>
  );
}
