import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, TextInput, View } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import type { GitSectionCommonProps } from '../sectionTypes';

interface GitScreenWorkspaceSectionProps extends GitSectionCommonProps {
  onOpenFiles?: () => void;
}

export function GitScreenWorkspaceSection({
  controller,
  styles,
  theme,
  onOpenFiles,
}: GitScreenWorkspaceSectionProps) {
  if (controller.features.managedWorkspaces) {
    // App-managed workspaces are chosen in the workspace picker, never typed as paths.
    const path = controller.requestedCwd ?? '';
    const name = path.split('/').filter(Boolean).pop() ?? 'No workspace';
    return (
      <View style={[styles.card, styles.workspaceCard]}>
        <Text style={styles.sectionLabel}>Workspace</Text>
        <View style={styles.workspaceRow}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="folder-outline"
            size={18}
            color={theme.colors.textSecondary}
          />
          <Text style={styles.workspaceValue} numberOfLines={1}>
            {name}
          </Text>
          {onOpenFiles && path ? (
            <Pressable
              onPress={onOpenFiles}
              style={({ pressed }) => [
                styles.workspaceFilesButton,
                pressed && styles.fileActionBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Browse files in ${name}`}
              testID="git-open-files"
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="document-text-outline"
                size={15}
                color={theme.colors.textPrimary}
              />
              <Text style={styles.syncButtonText}>Files</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.card, styles.workspaceCard]}>
      <Text style={styles.sectionLabel}>Workspace</Text>
      <TextInput
        style={[styles.input, styles.workspaceInput]}
        value={controller.workspaceDraft}
        onChangeText={(value) => controller.setWorkspaceDraft(value.replace(/\r?\n/g, ''))}
        keyboardAppearance={theme.keyboardAppearance}
        onSubmitEditing={controller.commitWorkspaceIfChanged}
        onBlur={controller.commitWorkspaceIfChanged}
        placeholder="/path/to/project"
        placeholderTextColor={theme.colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        multiline
        numberOfLines={2}
        submitBehavior="blurAndSubmit"
        scrollEnabled={false}
        textAlignVertical="top"
        editable={!controller.savingWorkspace}
        accessibilityLabel="Git workspace path"
      />

      {!controller.derived.hasWorkspace ? (
        <Text style={styles.warningText}>Using bridge root workspace.</Text>
      ) : null}
      {controller.savingWorkspace ? <Text style={styles.metaText}>Saving workspace...</Text> : null}
    </View>
  );
}
