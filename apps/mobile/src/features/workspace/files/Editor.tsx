import { Pressable, Text, TextInput, View } from 'react-native';

import type { AppTheme } from '@shared/theme';
import { fileName, formatFileSize, type WorkspaceFilesController } from './controller';
import type { WorkspaceFilesStyles } from './styles';

function Banner({
  styles,
  text,
  warning,
  actions,
  testID,
}: {
  styles: WorkspaceFilesStyles;
  text: string;
  warning?: boolean;
  actions?: { label: string; onPress: () => void; primary?: boolean; testID?: string }[];
  testID?: string;
}) {
  return (
    <View
      style={[styles.banner, warning && styles.bannerWarning]}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <Text style={styles.bannerText}>{text}</Text>
      {actions?.length ? (
        <View style={styles.bannerActions}>
          {actions.map((action) => (
            <Pressable
              key={action.label}
              onPress={action.onPress}
              style={[styles.bannerButton, action.primary && styles.bannerButtonPrimary]}
              accessibilityRole="button"
              testID={action.testID}
            >
              <Text
                style={[styles.bannerButtonText, action.primary && styles.bannerButtonTextPrimary]}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function FileEditor({
  controller,
  styles,
  theme,
}: {
  controller: WorkspaceFilesController;
  styles: WorkspaceFilesStyles;
  theme: AppTheme;
}) {
  const file = controller.file;
  if (!file) {
    return null;
  }
  const keepEditing = () => controller.setUnsavedBlocked(false);
  return (
    <>
      {file.truncated ? (
        <Banner
          styles={styles}
          testID="files-readonly-notice"
          text={`Showing the first ${formatFileSize(file.original.length)} of ${formatFileSize(
            file.totalBytes,
          )}. Files this large open read-only.`}
        />
      ) : null}
      {controller.unsavedBlocked ? (
        <Banner
          styles={styles}
          warning
          testID="files-unsaved-banner"
          text="You have unsaved edits. Save them or discard them before leaving this file."
          actions={[
            { label: 'Keep editing', onPress: keepEditing },
            {
              label: 'Discard edits',
              onPress: () => void controller.discardEdits(),
              testID: 'files-discard-edits',
            },
            {
              label: 'Save',
              onPress: () => void controller.save(),
              primary: true,
              testID: 'files-save-banner',
            },
          ]}
        />
      ) : null}
      {controller.conflict ? (
        <Banner
          styles={styles}
          warning
          text="This file changed since you opened it. Overwrite it with your edits, or discard them to see the latest version."
          actions={[
            { label: 'Discard edits', onPress: () => void controller.discardEdits() },
            {
              label: 'Overwrite',
              onPress: () => void controller.overwrite(),
              primary: true,
            },
          ]}
        />
      ) : controller.changedOnDisk ? (
        <Banner
          styles={styles}
          warning
          text="This file changed on disk while you were editing. Saving will ask before replacing it."
        />
      ) : null}
      <TextInput
        value={file.draft}
        onChangeText={controller.setDraft}
        editable={!file.truncated && !controller.saving}
        multiline
        scrollEnabled
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        keyboardAppearance={theme.keyboardAppearance}
        style={styles.editor}
        accessibilityLabel={`Contents of ${fileName(file.path)}`}
        testID="files-editor"
      />
    </>
  );
}
