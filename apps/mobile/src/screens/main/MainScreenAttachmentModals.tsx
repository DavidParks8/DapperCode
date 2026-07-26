import { useMainScreenStyles } from './useMainScreenStyles';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { decorativeAccessibilityProps } from '../../accessibility';
import { AppSheet } from '../../components/AppSheet';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';




type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenAttachmentModals({ context }: { context: Context }) {
  const {
    attachmentModalVisible,
    closeAttachmentModal,
    attachmentPathDraft,
    setAttachmentPathDraft,
    isLoading,
    submitAttachmentPath,
    loadingAttachmentFileCandidates,
    attachmentPathSuggestions,
    selectAttachmentSuggestion,
    pendingMentionPaths,
    removePendingMentionPath,
  } = context;
  const { theme, styles } = useMainScreenStyles();

  return (
    <AppSheet
      visible={attachmentModalVisible}
      onClose={closeAttachmentModal}
      accessibilityLabel="Attach file"
    >
      <Text style={styles.renameModalTitle}>Attach file</Text>
      <Text style={styles.attachmentModalHint}>
        Enter a workspace-relative path to include as context.
      </Text>
      <BottomSheetTextInput
        value={attachmentPathDraft}
        onChangeText={setAttachmentPathDraft}
        keyboardAppearance={theme.keyboardAppearance}
        placeholder="apps/mobile/src/screens/MainScreen.tsx"
        placeholderTextColor={theme.colors.textMuted}
        style={styles.renameModalInput}
        autoFocus
        editable={!isLoading}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={submitAttachmentPath}
        returnKeyType="done"
        accessibilityLabel="Workspace file path"
      />
      {loadingAttachmentFileCandidates ? (
        <Text style={styles.workspaceModalLoading}>Indexing files…</Text>
      ) : null}
      {attachmentPathSuggestions.length > 0 ? (
        <ScrollView
          style={styles.attachmentSuggestionsList}
          contentContainerStyle={styles.attachmentSuggestionsListContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {attachmentPathSuggestions.map((path, index) => (
            <Pressable
              key={`${path}-${String(index)}`}
              onPress={() => selectAttachmentSuggestion(path)}
              style={({ pressed }) => [
                styles.attachmentSuggestionItem,
                index === attachmentPathSuggestions.length - 1 &&
                  styles.attachmentSuggestionItemLast,
                pressed && styles.attachmentSuggestionItemPressed,
              ]}
            >
              <Text style={styles.attachmentSuggestionText} numberOfLines={1}>
                {path}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : attachmentPathDraft.trim() && !loadingAttachmentFileCandidates ? (
        <Text style={styles.workspaceModalLoading}>No matching files found.</Text>
      ) : null}
      {pendingMentionPaths.length > 0 ? (
        <View style={styles.attachmentListColumn}>
          {pendingMentionPaths.map((path, index) => (
            <View key={`${path}-${String(index)}`} style={styles.attachmentListRow}>
              <Text style={styles.attachmentListPath} numberOfLines={1}>
                {path}
              </Text>
              <Pressable
                onPress={() => removePendingMentionPath(path)}
                style={({ pressed }) => [
                  styles.attachmentRemoveButton,
                  pressed && styles.attachmentRemoveButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${path}`}
              >
                <Ionicons {...decorativeAccessibilityProps} name="close" size={14} color={theme.colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.renameModalActions}>
        <Pressable
          onPress={closeAttachmentModal}
          style={({ pressed }) => [
            styles.renameModalButton,
            styles.renameModalButtonSecondary,
            pressed && styles.renameModalButtonPressed,
          ]}
          disabled={isLoading}
        >
          <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={submitAttachmentPath}
          style={({ pressed }) => [
            styles.renameModalButton,
            styles.renameModalButtonPrimary,
            pressed && styles.renameModalButtonPrimaryPressed,
            (!attachmentPathDraft.trim() || isLoading) &&
              styles.renameModalButtonDisabled,
          ]}
          disabled={!attachmentPathDraft.trim() || isLoading}
        >
          <Text style={styles.renameModalButtonPrimaryText}>Attach</Text>
        </Pressable>
      </View>
    </AppSheet>
  );
}
