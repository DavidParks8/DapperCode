import { useRef, type ReactElement } from 'react';
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import type { FileSystemEntry } from '@bridge/types/types';
import type { AppTheme } from '@shared/theme';
import { EmptyRow, GroupedRow, LoadingRow } from './Primitives';
import type { WorkspacePickerStyles } from './styles';

/** Scroll distance that hides the large title, roughly its own height plus its top padding. */
const TITLE_COLLAPSE_OFFSET = 44;

export interface WorkspacePickerEntryMenuTarget {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

interface WorkspacePickerBrowserProps {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  entries: FileSystemEntry[];
  loadingEntries: boolean;
  normalizedSearch: string;
  listHeader: ReactElement;
  listFooter: ReactElement;
  onBrowsePath: (path: string | null) => void;
  onOpenEntryMenu?: (entry: FileSystemEntry, target: WorkspacePickerEntryMenuTarget | null) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

function WorkspacePickerEntryRow({
  styles,
  theme,
  entry,
  first,
  last,
  onBrowsePath,
  onOpenEntryMenu,
}: {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  entry: FileSystemEntry;
  first: boolean;
  last: boolean;
  onBrowsePath: (path: string | null) => void;
  onOpenEntryMenu?: (entry: FileSystemEntry, target: WorkspacePickerEntryMenuTarget | null) => void;
}) {
  const rowRef = useRef<View>(null);
  return (
    <View
      style={[
        styles.group,
        styles.groupFlush,
        first && styles.groupFirst,
        last && styles.groupLast,
      ]}
    >
      <GroupedRow
        rowRef={rowRef}
        styles={styles}
        theme={theme}
        icon={entry.isGitRepo ? 'git-branch' : 'folder'}
        title={entry.name}
        subtitle={entry.isGitRepo ? 'Git repository' : undefined}
        accessory="chevron"
        last={last}
        accessibilityLabel={`Open folder ${entry.name}`}
        accessibilityHint={onOpenEntryMenu ? 'Touch and hold for more actions' : undefined}
        onPress={() => onBrowsePath(entry.path)}
        onLongPress={onOpenEntryMenu ? () => onOpenEntryMenu(entry, rowRef.current) : undefined}
      />
    </View>
  );
}

/**
 * The picker's single scroll surface. Header, folders, and footer share one list so the large
 * title collapses into the nav bar the way a native `UITableViewController` behaves.
 */
export function WorkspacePickerBrowser({
  styles,
  theme,
  entries,
  loadingEntries,
  normalizedSearch,
  listHeader,
  listFooter,
  onBrowsePath,
  onOpenEntryMenu,
  onCollapsedChange,
}: WorkspacePickerBrowserProps) {
  const collapsedRef = useRef(false);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const collapsed = event.nativeEvent.contentOffset.y > TITLE_COLLAPSE_OFFSET;
    if (collapsed === collapsedRef.current) {
      return;
    }
    collapsedRef.current = collapsed;
    onCollapsedChange(collapsed);
  };

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={entries}
      keyExtractor={(entry) => entry.path}
      ListHeaderComponent={listHeader}
      ListFooterComponent={listFooter}
      ListEmptyComponent={
        <View style={styles.group}>
          {loadingEntries ? (
            <LoadingRow label="Loading folders..." />
          ) : (
            <EmptyRow
              label={normalizedSearch ? 'No folders match this search.' : 'No folders found here.'}
            />
          )}
        </View>
      }
      initialNumToRender={14}
      maxToRenderPerBatch={20}
      windowSize={7}
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onScroll={handleScroll}
      scrollEventThrottle={32}
      renderItem={({ item: entry, index }) => (
        <WorkspacePickerEntryRow
          styles={styles}
          theme={theme}
          entry={entry}
          first={index === 0}
          last={index === entries.length - 1}
          onBrowsePath={onBrowsePath}
          onOpenEntryMenu={onOpenEntryMenu}
        />
      )}
    />
  );
}
