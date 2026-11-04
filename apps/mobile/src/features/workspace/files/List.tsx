import { Text, View, FlatList } from 'react-native';

import type { AppTheme } from '@shared/theme';
import { SwipeToDeleteRow } from '@shared/ui/SwipeToDeleteRow';
import type { WorkspaceFileEntry } from '../api/protocol';
import { EmptyRow, GroupedRow, LoadingRow } from '../picker/Primitives';
import type { WorkspacePickerStyles } from '../picker/styles';
import { formatFileSize, type WorkspaceFilesController } from './controller';
import type { WorkspaceFilesStyles } from './styles';

function FileRow({
  entry,
  first,
  last,
  controller,
  pickerStyles,
  theme,
  onRename,
}: {
  entry: WorkspaceFileEntry;
  first: boolean;
  last: boolean;
  controller: WorkspaceFilesController;
  pickerStyles: WorkspacePickerStyles;
  theme: AppTheme;
  onRename: (entry: WorkspaceFileEntry) => void;
}) {
  const isDirectory = entry.kind === 'directory';
  const opening = controller.opening === entry.path;
  return (
    <View
      style={[
        pickerStyles.group,
        pickerStyles.groupFlush,
        first && pickerStyles.groupFirst,
        last && pickerStyles.groupLast,
      ]}
    >
      <SwipeToDeleteRow
        onDelete={() => controller.removeEntry(entry)}
        deleteAccessibilityLabel={`Delete ${entry.name}`}
        actionAccessibilityHint={
          isDirectory ? 'Deletes this folder and everything in it.' : 'Deletes this file.'
        }
        contentBackgroundColor={theme.colors.bgItem}
      >
        <GroupedRow
          styles={pickerStyles}
          theme={theme}
          icon={isDirectory ? 'folder' : 'document-text-outline'}
          title={entry.name}
          value={isDirectory ? undefined : opening ? 'Opening…' : formatFileSize(entry.bytes)}
          accessory={isDirectory ? 'chevron' : 'none'}
          last={last}
          accessibilityLabel={isDirectory ? `Open folder ${entry.name}` : `Open ${entry.name}`}
          accessibilityHint="Touch and hold to rename. Swipe left to delete."
          onPress={() =>
            isDirectory ? controller.openDirectory(entry.path) : void controller.openFile(entry)
          }
          onLongPress={() => onRename(entry)}
        />
      </SwipeToDeleteRow>
    </View>
  );
}

export function FileList({
  controller,
  pickerStyles,
  styles,
  theme,
  onRename,
}: {
  controller: WorkspaceFilesController;
  pickerStyles: WorkspacePickerStyles;
  styles: WorkspaceFilesStyles;
  theme: AppTheme;
  onRename: (entry: WorkspaceFileEntry) => void;
}) {
  const entries = controller.listing?.entries ?? [];
  return (
    <FlatList
      style={pickerStyles.list}
      contentContainerStyle={pickerStyles.listContent}
      data={entries}
      keyExtractor={(entry) => entry.path}
      testID="files-list"
      ListEmptyComponent={
        <View style={pickerStyles.group}>
          {controller.loading && !controller.listing ? (
            <LoadingRow label="Loading files..." />
          ) : controller.error && !controller.listing ? null : (
            <EmptyRow label="This folder is empty." />
          )}
        </View>
      }
      ListFooterComponent={
        <View style={pickerStyles.listFooter}>
          {controller.listing?.truncated ? (
            <Text style={pickerStyles.footerNote}>
              Showing the first {String(controller.listing.limit)} items in this folder.
            </Text>
          ) : null}
          {entries.length > 0 ? (
            <Text style={pickerStyles.footerNote}>
              Touch and hold to rename. Swipe left to delete.
            </Text>
          ) : null}
        </View>
      }
      renderItem={({ item, index }) => (
        <FileRow
          entry={item}
          first={index === 0}
          last={index === entries.length - 1}
          controller={controller}
          pickerStyles={pickerStyles}
          theme={theme}
          onRename={onRename}
        />
      )}
      ListHeaderComponent={
        controller.notice ? (
          <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
            {controller.notice}
          </Text>
        ) : null
      }
    />
  );
}
