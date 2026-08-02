import { Ionicons } from '@expo/vector-icons';
import { FlatList, Pressable, Text, View } from 'react-native';

import type { FileSystemEntry } from '@bridge/types/types';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import type { AppTheme } from '@shared/theme';
import { ENTRY_ROW_HEIGHT, showWorkspacePinAction } from './helpers';
import { EmptyRow, LoadingRow } from './Primitives';
import type { WorkspacePickerStyles } from './styles';

export function WorkspacePickerBrowser({
  styles,
  theme,
  entries,
  loadingEntries,
  normalizedSearch,
  favoritePathSet,
  onBrowsePath,
  onToggleFavorite,
}: {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  entries: FileSystemEntry[];
  loadingEntries: boolean;
  normalizedSearch: string;
  favoritePathSet: Set<string>;
  onBrowsePath: (path: string | null) => void;
  onToggleFavorite?: (path: string | null) => void;
}) {
  if (loadingEntries && entries.length === 0) {
    return (
      <View style={styles.browserCard}>
        <LoadingRow label="Loading folders..." />
      </View>
    );
  }
  if (entries.length === 0) {
    return (
      <View style={styles.browserCard}>
        <EmptyRow
          label={normalizedSearch ? 'No folders match this search.' : 'No folders found here.'}
        />
      </View>
    );
  }
  return (
    <View style={styles.browserCard}>
      <FlatList
        style={styles.entryListScroll}
        contentContainerStyle={styles.entryListContent}
        data={entries}
        keyExtractor={(entry) => entry.path}
        initialNumToRender={18}
        maxToRenderPerBatch={24}
        removeClippedSubviews
        windowSize={7}
        getItemLayout={(_, index) => ({
          length: ENTRY_ROW_HEIGHT,
          offset: ENTRY_ROW_HEIGHT * index,
          index,
        })}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: entry, index }) => (
          <View style={[styles.entryRow, index === entries.length - 1 && styles.entryRowLast]}>
            <Pressable
              onPress={() => onBrowsePath(entry.path)}
              onLongPress={() =>
                onToggleFavorite &&
                showWorkspacePinAction(favoritePathSet.has(entry.path), () =>
                  onToggleFavorite(entry.path),
                )
              }
              style={({ pressed }) => [styles.rowMainAction, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Open folder ${entry.name}`}
              accessibilityHint={
                onToggleFavorite ? 'Long press to pin or unpin this workspace' : undefined
              }
            >
              <View style={styles.entryIconWrap}>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name={entry.isGitRepo ? 'git-branch-outline' : 'folder-outline'}
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </View>
              <View style={styles.entryCopy}>
                <Text style={styles.entryName} numberOfLines={1}>
                  {entry.name}
                </Text>
              </View>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="chevron-forward"
                size={15}
                color={theme.colors.textMuted}
              />
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}
