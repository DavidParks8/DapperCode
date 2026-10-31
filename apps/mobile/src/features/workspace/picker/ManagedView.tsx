import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { FlatList, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { decorativeAccessibilityProps, useModalAccessibilityFocus } from '@shared/accessibility';
import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { SwipeToDeleteRow } from '@shared/ui/SwipeToDeleteRow';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';
import type { ManagedWorkspaceSummary } from '../api/protocol';
import { fileNameError } from '../files/controller';
import { NameSheet } from '../NameSheet';
import { matchesSearch } from './helpers';
import {
  measureMenuAnchor,
  WorkspacePickerMenu,
  type WorkspacePickerMenuItem,
  type WorkspacePickerMenuState,
} from './Menu';
import { EmptyRow, GroupedRow, LoadingRow } from './Primitives';
import { createWorkspacePickerStyles, type WorkspacePickerStyles } from './styles';
import { NAV_BAR_TEXT_BUTTON_HEIGHT, NAV_BAR_TEXT_BUTTON_WIDTH } from './stylesLayout';

export interface ManagedWorkspacePickerProps {
  selectedPath: string | null;
  entries: ManagedWorkspaceSummary[];
  /** Changed-file counts of Git workspaces by path, loaded after the list. */
  changedFiles?: Readonly<Record<string, number>>;
  loading: boolean;
  error: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
  onClone: () => void;
  onRename: (path: string, name: string) => Promise<boolean>;
  onDelete: (path: string) => Promise<boolean>;
  onBrowseFiles?: (path: string) => void;
}

type SheetState = { kind: 'create' } | { kind: 'rename'; entry: ManagedWorkspaceSummary };

function workingTreeLabel(changedFiles: number | undefined): string | null {
  if (changedFiles === undefined) {
    return null;
  }
  return changedFiles === 0 ? 'Clean' : `${String(changedFiles)} changed`;
}

/**
 * "main · 2 changed · github.com/owner/repo", or why a workspace has no Git details. The
 * working-tree state is left out until it has loaded.
 */
export function managedWorkspaceSubtitle(
  entry: ManagedWorkspaceSummary,
  changedFiles?: number,
): string {
  if (!entry.isRepository) {
    return 'Not a Git repository';
  }
  const origin = entry.origin
    ?.replace(/^https?:\/\//u, '')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '');
  const parts = [
    entry.branch ?? null,
    workingTreeLabel(changedFiles),
    origin ?? 'No remote',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Git repository';
}

function WorkspaceRow({
  entry,
  changedFiles,
  first,
  last,
  selected,
  styles,
  theme,
  onSelect,
  onDelete,
  onOpenMenu,
}: {
  entry: ManagedWorkspaceSummary;
  changedFiles: number | undefined;
  first: boolean;
  last: boolean;
  selected: boolean;
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  onSelect: () => void;
  onDelete: () => Promise<boolean>;
  onOpenMenu: (target: View | null) => void;
}) {
  const rowRef = useRef<View>(null);
  const subtitle = managedWorkspaceSubtitle(entry, changedFiles);
  return (
    <View
      style={[
        styles.group,
        styles.groupFlush,
        first && styles.groupFirst,
        last && styles.groupLast,
      ]}
    >
      <SwipeToDeleteRow
        onDelete={onDelete}
        deleteAccessibilityLabel={`Delete workspace ${entry.name}`}
        actionAccessibilityHint="Deletes this workspace and all of its files from this device. Its chats stay readable."
        contentBackgroundColor={theme.colors.bgItem}
      >
        <GroupedRow
          rowRef={rowRef}
          styles={styles}
          theme={theme}
          icon={entry.isRepository ? 'git-branch' : 'folder'}
          title={entry.name}
          subtitle={subtitle}
          accessory="check"
          selected={selected}
          last={last}
          accessibilityLabel={`${entry.name}, ${subtitle}`}
          accessibilityHint={
            selected
              ? 'New chats use this workspace. Touch and hold for more actions.'
              : 'Uses this workspace for new chats. Touch and hold for more actions.'
          }
          // The workspace in use is already chosen; tapping it again does nothing.
          onPress={selected ? () => undefined : onSelect}
          onLongPress={() => onOpenMenu(rowRef.current)}
        />
      </SwipeToDeleteRow>
    </View>
  );
}

function ManagedListHeader({
  styles,
  theme,
  focusRef,
  search,
  onSearch,
  count,
  onCreate,
  onClone,
}: {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  focusRef: RefObject<Text | null>;
  search: string;
  onSearch: (value: string) => void;
  count: number;
  onCreate: () => void;
  onClone: () => void;
}) {
  return (
    <View style={styles.listHeader}>
      <View style={styles.largeTitleWrap}>
        <Text ref={focusRef} accessibilityRole="header" style={styles.largeTitle}>
          Workspaces
        </Text>
      </View>
      <View style={styles.searchField}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="search"
          size={16}
          color={theme.colors.textMuted}
        />
        <TextInput
          value={search}
          onChangeText={onSearch}
          keyboardAppearance={theme.keyboardAppearance}
          placeholder="Search workspaces"
          placeholderTextColor={theme.colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Search workspaces"
        />
      </View>
      <View style={styles.section}>
        <View style={styles.group}>
          <GroupedRow
            styles={styles}
            theme={theme}
            icon="add-circle-outline"
            title="New workspace"
            subtitle="An empty folder you can initialize with Git later"
            accessibilityLabel="New workspace"
            onPress={onCreate}
          />
          <GroupedRow
            styles={styles}
            theme={theme}
            icon="cloud-download-outline"
            title="Clone repository"
            subtitle="Copy an HTTPS Git repository to this device"
            accessory="chevron"
            last
            accessibilityLabel="Clone repository"
            onPress={() => {
              void feedback.selection();
              onClone();
            }}
          />
        </View>
      </View>
      {count > 0 ? (
        <Text style={styles.sectionTitle}>
          {count === 1 ? '1 workspace' : `${String(count)} workspaces`}
        </Text>
      ) : null}
    </View>
  );
}

function ManagedListFooter({
  styles,
  error,
  hasEntries,
}: {
  styles: WorkspacePickerStyles;
  error: string | null;
  hasEntries: boolean;
}) {
  return (
    <View style={styles.listFooter}>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
      {hasEntries ? (
        <Text style={styles.footerNote}>
          Tap a workspace to use it for new chats. Touch and hold to rename or browse files. Swipe
          left to delete it from this device.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Workspace picker for hosts whose workspaces are an app-managed list ("On this iPhone"): tap to
 * use, create, clone, rename, browse files, and swipe to delete. Shares the bridge picker's
 * grouped-list styles, rows, and menu so both read as one design.
 */
export function ManagedWorkspacePicker(props: ManagedWorkspacePickerProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  const sceneInsets = useSceneHorizontalInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<WorkspacePickerMenuState | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const focusRef = useModalAccessibilityFocus<Text>(true);
  useAccessibilityAnnouncement(props.error);
  useAccessibilityAnnouncement(props.loading ? 'Loading workspaces' : null);

  const query = search.trim().toLowerCase();
  const entries = props.entries.filter((entry) =>
    matchesSearch([entry.name, entry.origin ?? '', entry.branch ?? ''], query),
  );

  const select = (path: string) => {
    void feedback.selection();
    props.onSelect(path);
  };

  const openMenu = (entry: ManagedWorkspaceSummary, target: View | null) => {
    void feedback.selection();
    const items: WorkspacePickerMenuItem[] = [];
    if (entry.path !== props.selectedPath) {
      items.push({
        key: 'use',
        label: `Use ${entry.name}`,
        icon: 'checkmark-circle-outline',
        onPress: () => select(entry.path),
      });
    }
    items.push({
      key: 'rename',
      label: 'Rename',
      icon: 'pencil-outline',
      onPress: () => setSheet({ kind: 'rename', entry }),
    });
    if (props.onBrowseFiles) {
      const browse = props.onBrowseFiles;
      items.push({
        key: 'files',
        label: 'Browse files',
        icon: 'document-text-outline',
        onPress: () => browse(entry.path),
      });
    }
    const presented: WorkspacePickerMenuState = {
      id: `workspace:${entry.path}`,
      accessibilityLabel: `${entry.name} actions`,
      title: entry.name,
      anchor: {
        x: theme.spacing.lg,
        y: windowHeight / 2,
        width: windowWidth - theme.spacing.lg * 2,
        height: 56,
      },
      align: 'start',
      items,
    };
    setMenu(presented);
    measureMenuAnchor(target, (anchor) => {
      setMenu((current) => (current?.id === presented.id ? { ...current, anchor } : current));
    });
  };

  return (
    <View style={styles.root}>
      <SafeAreaView
        style={[styles.screen, sceneInsets]}
        edges={['top', 'bottom']}
        accessibilityElementsHidden={menu !== null}
        importantForAccessibility={menu !== null ? 'no-hide-descendants' : 'auto'}
      >
        <View style={styles.navBar}>
          <View style={styles.navBarSide}>
            <Pressable
              onPress={() => {
                void feedback.selection();
                props.onClose();
              }}
              hitSlop={computeHitSlop({
                width: NAV_BAR_TEXT_BUTTON_WIDTH,
                height: NAV_BAR_TEXT_BUTTON_HEIGHT,
              })}
              style={({ pressed }) => [styles.navBarTextButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text style={styles.navBarButtonLabel}>Done</Text>
            </Pressable>
          </View>
        </View>
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={entries}
          keyExtractor={(entry) => entry.path}
          ListHeaderComponent={
            <ManagedListHeader
              styles={styles}
              theme={theme}
              focusRef={focusRef}
              search={search}
              onSearch={setSearch}
              count={entries.length}
              onCreate={() => setSheet({ kind: 'create' })}
              onClone={props.onClone}
            />
          }
          testID="managed-workspace-list"
          ListEmptyComponent={
            <View style={styles.group}>
              {props.loading ? (
                <LoadingRow label="Loading workspaces..." />
              ) : (
                <EmptyRow
                  label={
                    query
                      ? 'No workspaces match this search.'
                      : 'No workspaces yet. Create one or clone a repository.'
                  }
                />
              )}
            </View>
          }
          ListFooterComponent={
            <ManagedListFooter
              styles={styles}
              error={props.error}
              hasEntries={entries.length > 0}
            />
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={({ item, index }) => (
            <WorkspaceRow
              entry={item}
              changedFiles={props.changedFiles?.[item.path]}
              first={index === 0}
              last={index === entries.length - 1}
              selected={item.path === props.selectedPath}
              styles={styles}
              theme={theme}
              onSelect={() => select(item.path)}
              onDelete={() => props.onDelete(item.path)}
              onOpenMenu={(target) => openMenu(item, target)}
            />
          )}
        />
      </SafeAreaView>
      {menu ? (
        <WorkspacePickerMenu
          menu={menu}
          styles={styles}
          theme={theme}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      <NameSheet
        visible={sheet?.kind === 'create'}
        title="New workspace"
        placeholder="my-project"
        submitLabel="Create"
        validate={fileNameError}
        onSubmit={props.onCreate}
        onClose={() => setSheet(null)}
        testID="workspace-create-sheet"
      />
      <NameSheet
        visible={sheet?.kind === 'rename'}
        title={sheet?.kind === 'rename' ? `Rename ${sheet.entry.name}` : 'Rename workspace'}
        initialValue={sheet?.kind === 'rename' ? sheet.entry.name : ''}
        placeholder="Workspace name"
        submitLabel="Rename"
        validate={fileNameError}
        onSubmit={(name) =>
          sheet?.kind === 'rename' ? props.onRename(sheet.entry.path, name) : Promise.resolve(false)
        }
        onClose={() => setSheet(null)}
        testID="workspace-rename-sheet"
      />
    </View>
  );
}
