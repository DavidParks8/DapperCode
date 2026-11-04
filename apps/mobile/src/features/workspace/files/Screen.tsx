import { router, useFocusEffect } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useAtomValue } from 'jotai';
import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { SceneToolbarHost, useInlineToolbar } from '@shell/layout/SceneToolbar';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';
import { activeProfileFeaturesAtom } from '@shell/state/bridge/atoms';
import { workspaceHostClientAtom } from '../api/atoms';
import type { WorkspaceFileEntry } from '../api/protocol';
import { NameSheet } from '../NameSheet';
import { createWorkspacePickerStyles } from '../picker/styles';
import {
  fileNameError,
  parentFilePath,
  useWorkspaceFiles,
  type WorkspaceFilesController,
} from './controller';
import { FileEditor } from './Editor';
import { FilesHeader, filesToolbarItems, type FilesHeaderActions } from './Header';
import { FileList } from './List';
import { createWorkspaceFilesStyles, type WorkspaceFilesStyles } from './styles';

type SheetState = { kind: 'create' } | { kind: 'rename'; entry: WorkspaceFileEntry } | null;

function Unavailable({
  styles,
  title,
  body,
}: {
  styles: WorkspaceFilesStyles;
  title: string;
  body: string;
}) {
  return (
    <View style={styles.centered}>
      <Text accessibilityRole="header" style={styles.centeredTitle}>
        {title}
      </Text>
      <Text style={styles.centeredBody}>{body}</Text>
    </View>
  );
}

function FilesBody({
  controller,
  available,
  cwd,
  styles,
  onRename,
}: {
  controller: WorkspaceFilesController;
  available: boolean;
  cwd: string | null;
  styles: WorkspaceFilesStyles;
  onRename: (entry: WorkspaceFileEntry) => void;
}) {
  const theme = useAppTheme();
  const pickerStyles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  if (!available) {
    return (
      <Unavailable
        styles={styles}
        title="Files aren't available here"
        body="This connection doesn't offer a file browser. Ask the agent to read or edit files instead."
      />
    );
  }
  if (!cwd) {
    return (
      <Unavailable
        styles={styles}
        title="Choose a workspace"
        body="Pick a workspace for this chat first, then open its files."
      />
    );
  }
  return (
    <>
      {controller.error ? (
        <Text accessibilityRole="alert" style={styles.errorText} testID="files-error">
          {controller.error}
        </Text>
      ) : null}
      {controller.file ? (
        <>
          {controller.notice ? (
            <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
              {controller.notice}
            </Text>
          ) : null}
          <FileEditor controller={controller} styles={styles} theme={theme} />
        </>
      ) : (
        <FileList
          controller={controller}
          pickerStyles={pickerStyles}
          styles={styles}
          theme={theme}
          onRename={onRename}
        />
      )}
    </>
  );
}

/**
 * Browse and edit a workspace's files through the host's `workspace/files/*` extensions. Shares
 * the workspace picker's grouped-list design; edits are explicit (Save or Discard), and leaving a
 * file or the screen with unsaved edits is refused with an inline explanation, never a dialog.
 */
export function WorkspaceFilesScreen({ cwd }: { cwd: string | null }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createWorkspaceFilesStyles(theme), [theme]);
  const sceneInsets = useSceneHorizontalInsets();
  const inlineToolbar = useInlineToolbar();
  const features = useAtomValue(activeProfileFeaturesAtom);
  const host = useAtomValue(workspaceHostClientAtom);
  const available = features.workspaceFiles && host !== null;
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const controller = useWorkspaceFiles({
    host: available ? host : null,
    cwd: available ? cwd : null,
    focused,
  });
  useAccessibilityAnnouncement(controller.error);
  usePreventRemove(controller.dirty, () => controller.setUnsavedBlocked(true));

  const actions: FilesHeaderActions = {
    back: () => {
      if (controller.file) {
        controller.closeFile();
      } else if (controller.directory) {
        controller.openDirectory(parentFilePath(controller.directory));
      } else {
        router.back();
      }
    },
    newFile: () => setSheet({ kind: 'create' }),
  };
  const enabled = available && Boolean(cwd);

  return (
    <SceneToolbarHost items={filesToolbarItems(controller, enabled, actions)}>
      <SafeAreaView
        style={[styles.screen, sceneInsets]}
        edges={['top', 'bottom']}
        testID="files-screen"
      >
        <KeyboardAvoidingView
          style={styles.screenBody}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <FilesHeader
            controller={controller}
            cwd={cwd}
            styles={styles}
            theme={theme}
            inline={inlineToolbar}
            enabled={enabled}
            actions={actions}
          />
          <FilesBody
            controller={controller}
            available={available}
            cwd={cwd}
            styles={styles}
            onRename={(entry) => setSheet({ kind: 'rename', entry })}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
      <NameSheet
        visible={sheet?.kind === 'create'}
        title="New file"
        placeholder="notes.md"
        submitLabel="Create"
        validate={fileNameError}
        onSubmit={(name) => controller.createFile(name)}
        onClose={() => setSheet(null)}
        testID="files-create-sheet"
      />
      <NameSheet
        visible={sheet?.kind === 'rename'}
        title={sheet?.kind === 'rename' ? `Rename ${sheet.entry.name}` : 'Rename'}
        initialValue={sheet?.kind === 'rename' ? sheet.entry.name : ''}
        placeholder="New name"
        submitLabel="Rename"
        validate={fileNameError}
        onSubmit={(name) =>
          sheet?.kind === 'rename'
            ? controller.renameEntry(sheet.entry, name)
            : Promise.resolve(false)
        }
        onClose={() => setSheet(null)}
        testID="files-rename-sheet"
      />
    </SceneToolbarHost>
  );
}
