import { Text, TextInput, View } from 'react-native';

import type { GitSectionCommonProps } from './gitScreenSectionTypes';

export function GitScreenWorkspaceSection({ controller, styles, theme }: GitSectionCommonProps) {
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
        blurOnSubmit
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
