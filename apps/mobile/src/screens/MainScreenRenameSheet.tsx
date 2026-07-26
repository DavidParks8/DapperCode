import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useAtomValue, useSetAtom } from 'jotai';
import { Pressable, Text, View } from 'react-native';

import { AppSheet } from '../components/AppSheet';
import {
  titleDraftAtom,
  titleModalVisibleAtom,
  titleSavingAtom,
} from '../state/mainScreen/modals';
import { useMainScreenStyles } from './useMainScreenStyles';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenRenameSheet({ context }: { context: Context }) {
  const { closeTitleEditor, saveTitle } = context;
  const { styles } = useMainScreenStyles();
  const titleModalVisible = useAtomValue(titleModalVisibleAtom);
  const titleDraft = useAtomValue(titleDraftAtom);
  const titleSaving = useAtomValue(titleSavingAtom);
  const setTitleDraft = useSetAtom(titleDraftAtom);

  return (
    <AppSheet
        visible={titleModalVisible}
        onClose={closeTitleEditor}
        accessibilityLabel="Rename session"
      >
        <Text style={styles.renameModalTitle}>Rename session</Text>
        <BottomSheetTextInput
          value={titleDraft}
          onChangeText={setTitleDraft}
          style={styles.renameModalInput}
          accessibilityLabel="Session title"
          autoFocus
          maxLength={256}
          editable={!titleSaving}
          returnKeyType="done"
          onSubmitEditing={() => { void saveTitle(); }}
        />
        <View style={styles.renameModalActions}>
          <Pressable
            onPress={closeTitleEditor}
            style={[styles.renameModalButton, styles.renameModalButtonSecondary]}
            disabled={titleSaving}
            accessibilityRole="button"
            accessibilityLabel="Cancel rename"
          >
            <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => { void saveTitle(); }}
            style={[
              styles.renameModalButton,
              styles.renameModalButtonPrimary,
              (!titleDraft.trim() || titleSaving) && styles.renameModalButtonDisabled,
            ]}
            disabled={!titleDraft.trim() || titleSaving}
            accessibilityRole="button"
            accessibilityLabel="Save session title"
          >
            <Text style={styles.renameModalButtonPrimaryText}>
              {titleSaving ? 'Saving...' : 'Save'}
            </Text>
          </Pressable>
        </View>
      </AppSheet>
  );
}
