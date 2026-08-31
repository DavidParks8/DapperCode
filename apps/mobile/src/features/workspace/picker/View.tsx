import { Ionicons } from '@expo/vector-icons';
import { useRef, useState, type RefObject } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { FileSystemEntry, WorkspaceSummary } from '@bridge/types/types';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import type { AppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { motionDuration } from '@shared/ui/motion';
import { WorkspacePickerBrowser, type WorkspacePickerEntryMenuTarget } from './Browser';
import { WorkspacePickerListFooter, WorkspacePickerToolbar } from './Footer';
import { formatFolderCount, toPathCrumbs } from './helpers';
import {
  measureMenuAnchor,
  WorkspacePickerMenu,
  type WorkspacePickerMenuAnchor,
  type WorkspacePickerMenuItem,
  type WorkspacePickerMenuState,
} from './Menu';
import type { WorkspacePickerStyles } from './styles';
import {
  NAV_BAR_CIRCLE_SIZE,
  NAV_BAR_TEXT_BUTTON_HEIGHT,
  NAV_BAR_TEXT_BUTTON_WIDTH,
} from './stylesLayout';
import { WorkspacePickerListHeader } from './TopSection';

export interface WorkspacePickerViewProps {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  screenFocusRef: RefObject<Text | null>;
  onClose: () => void;
  selectedPath: string | null;
  bridgeRoot: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onSelectPath: (path: string | null) => void;
  actionLabel: string | null;
  actionDescription: string | null;
  actionDisabled: boolean;
  onActionPress?: (path: string | null) => void;
  favoriteWorkspaces: WorkspaceSummary[];
  favoritePathSet: Set<string>;
  pendingSelectionPath: string | null;
  onBrowsePath: (path: string | null) => void;
  onToggleFavorite?: (path: string | null) => void;
  parentPath: string | null;
  loadingEntries: boolean;
  filteredEntries: FileSystemEntry[];
  normalizedSearch: string;
  currentFolderTitle: string;
  currentFolderPath: string | null;
  error: string | null;
  refreshError: string | null;
  truncationMessage: string | null;
  footerPath: string | null;
  footerTitle: string;
  footerSubtitle: string;
  footerIsFavorite: boolean;
}

function buildPathMenuItems(props: WorkspacePickerViewProps): WorkspacePickerMenuItem[] {
  const crumbs = toPathCrumbs(props.currentFolderPath);
  const reachable = props.parentPath ? crumbs : crumbs.slice(0, 1);
  return reachable.map((crumb) => ({
    key: crumb.path,
    label: crumb.name,
    accessibilityLabel: crumb.depth === 0 ? undefined : `Go to ${crumb.name}`,
    icon: crumb.depth === 0 ? 'folder-open' : 'folder',
    indent: crumb.depth,
    selected: crumb.depth === 0,
    onPress: () => {
      if (crumb.depth > 0) {
        props.onBrowsePath(crumb.path);
      }
    },
  }));
}

function buildOverflowMenuItems(props: WorkspacePickerViewProps): WorkspacePickerMenuItem[] {
  const items: WorkspacePickerMenuItem[] = [];
  if (props.onToggleFavorite && props.footerPath) {
    const path = props.footerPath;
    items.push({
      key: 'pin',
      label: props.footerIsFavorite ? `Unpin ${props.footerTitle}` : `Pin ${props.footerTitle}`,
      icon: props.footerIsFavorite ? 'star' : 'star-outline',
      onPress: () => props.onToggleFavorite?.(path),
    });
  }
  if (props.actionLabel && props.onActionPress) {
    const path = props.footerPath;
    items.push({
      key: 'action',
      label: props.actionLabel,
      accessibilityLabel: props.actionLabel,
      accessibilityHint: props.actionDescription ?? 'Clones a repository into this folder',
      icon: 'git-branch-outline',
      disabled: props.actionDisabled,
      onPress: () => props.onActionPress?.(path),
    });
  }
  return items;
}

function buildEntryMenuItems(
  props: WorkspacePickerViewProps,
  entry: FileSystemEntry,
): WorkspacePickerMenuItem[] {
  const items: WorkspacePickerMenuItem[] = [
    {
      key: 'use',
      label: `Use ${entry.name}`,
      icon: 'checkmark-circle-outline',
      onPress: () => props.onSelectPath(entry.path),
    },
  ];
  if (props.onToggleFavorite) {
    const pinned = props.favoritePathSet.has(entry.path);
    items.push({
      key: 'pin',
      label: pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`,
      icon: pinned ? 'star' : 'star-outline',
      onPress: () => props.onToggleFavorite?.(entry.path),
    });
  }
  if (props.actionLabel && props.onActionPress) {
    items.push({
      key: 'action',
      label: props.actionLabel,
      accessibilityHint: props.actionDescription ?? 'Clones a repository into this folder',
      icon: 'git-branch-outline',
      disabled: props.actionDisabled,
      onPress: () => props.onActionPress?.(entry.path),
    });
  }
  return items;
}

function WorkspacePickerNavBar({
  styles,
  theme,
  collapsed,
  currentFolderTitle,
  hasOverflowMenu,
  inlineTitleRef,
  overflowRef,
  onClose,
  onOpenPathMenu,
  onOpenOverflowMenu,
}: {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  collapsed: boolean;
  currentFolderTitle: string;
  hasOverflowMenu: boolean;
  inlineTitleRef: RefObject<View | null>;
  overflowRef: RefObject<View | null>;
  onClose: () => void;
  onOpenPathMenu: (target: WorkspacePickerEntryMenuTarget | null) => void;
  onOpenOverflowMenu: () => void;
}) {
  return (
    <View style={[styles.navBar, collapsed && styles.navBarScrolled]}>
      <View style={styles.navBarSide}>
        <Pressable
          onPress={onClose}
          hitSlop={computeHitSlop({
            width: NAV_BAR_TEXT_BUTTON_WIDTH,
            height: NAV_BAR_TEXT_BUTTON_HEIGHT,
          })}
          style={({ pressed }) => [styles.navBarTextButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={styles.navBarButtonLabel}>Cancel</Text>
        </Pressable>
      </View>
      <View style={styles.navBarTitleSlot} pointerEvents={collapsed ? 'auto' : 'none'}>
        {collapsed ? (
          <Animated.View
            entering={FadeIn.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
            style={styles.navBarTitleWrap}
          >
            <View ref={inlineTitleRef} collapsable={false}>
              <Pressable
                onPress={() => onOpenPathMenu(inlineTitleRef.current)}
                style={({ pressed }) => [styles.navBarTitleButton, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${currentFolderTitle}, current folder`}
                accessibilityHint="Shows the folders this one sits inside"
              >
                <Text style={styles.navBarTitle} numberOfLines={1}>
                  {currentFolderTitle}
                </Text>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="chevron-down"
                  size={12}
                  color={theme.colors.textMuted}
                />
              </Pressable>
            </View>
          </Animated.View>
        ) : null}
      </View>
      <View style={[styles.navBarSide, styles.navBarSideEnd]}>
        {hasOverflowMenu ? (
          <View ref={overflowRef} collapsable={false}>
            <Pressable
              onPress={onOpenOverflowMenu}
              hitSlop={computeHitSlop({
                width: NAV_BAR_CIRCLE_SIZE,
                height: NAV_BAR_CIRCLE_SIZE,
              })}
              style={({ pressed }) => [styles.navBarCircleButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="More actions"
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="ellipsis-horizontal"
                size={17}
                color={theme.colors.accent}
              />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function WorkspacePickerView(props: WorkspacePickerViewProps) {
  const { styles, theme } = props;
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menu, setMenu] = useState<WorkspacePickerMenuState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const titleAnchorRef = useRef<View>(null);
  const inlineTitleRef = useRef<View>(null);
  const overflowRef = useRef<View>(null);

  const openMenu = (
    target: WorkspacePickerEntryMenuTarget | null,
    fallback: WorkspacePickerMenuAnchor,
    build: (anchor: WorkspacePickerMenuAnchor) => WorkspacePickerMenuState,
  ) => {
    void feedback.selection();
    const presented = build(fallback);
    setMenu(presented);
    measureMenuAnchor(target, (anchor) => {
      setMenu((current) => (current?.id === presented.id ? { ...current, anchor } : current));
    });
  };

  const openPathMenu = (target: WorkspacePickerEntryMenuTarget | null) => {
    openMenu(target, { x: theme.spacing.lg, y: 92, width: 220, height: 40 }, (anchor) => ({
      id: 'path',
      accessibilityLabel: 'Folder path',
      anchor,
      align: 'start',
      items: buildPathMenuItems(props),
    }));
  };

  const openOverflowMenu = () => {
    openMenu(
      overflowRef.current,
      { x: windowWidth - 52, y: 52, width: 36, height: 36 },
      (anchor) => ({
        id: 'overflow',
        accessibilityLabel: 'More actions',
        anchor,
        align: 'end',
        items: buildOverflowMenuItems(props),
      }),
    );
  };

  const openEntryMenu = (entry: FileSystemEntry, target: WorkspacePickerEntryMenuTarget | null) => {
    openMenu(
      target,
      {
        x: theme.spacing.lg,
        y: windowHeight / 2,
        width: windowWidth - theme.spacing.lg * 2,
        height: 56,
      },
      (anchor) => ({
        id: `entry:${entry.path}`,
        accessibilityLabel: `${entry.name} actions`,
        title: entry.name,
        anchor,
        align: 'start',
        items: buildEntryMenuItems(props, entry),
      }),
    );
  };

  const overflowItems = buildOverflowMenuItems(props);
  const folderCountLabel =
    props.filteredEntries.length > 0 ? formatFolderCount(props.filteredEntries.length) : null;
  const hint =
    props.filteredEntries.length > 0 && !props.error
      ? 'Touch and hold a folder to use, pin, or clone into it.'
      : null;

  return (
    <View style={styles.root}>
      <SafeAreaView
        style={styles.screen}
        edges={['top', 'bottom']}
        accessibilityElementsHidden={menu !== null}
        importantForAccessibility={menu !== null ? 'no-hide-descendants' : 'auto'}
      >
        <WorkspacePickerNavBar
          styles={styles}
          theme={theme}
          collapsed={collapsed}
          currentFolderTitle={props.currentFolderTitle}
          hasOverflowMenu={overflowItems.length > 0}
          inlineTitleRef={inlineTitleRef}
          overflowRef={overflowRef}
          onClose={props.onClose}
          onOpenPathMenu={openPathMenu}
          onOpenOverflowMenu={openOverflowMenu}
        />
        <WorkspacePickerBrowser
          styles={styles}
          theme={theme}
          entries={props.filteredEntries}
          loadingEntries={props.loadingEntries}
          normalizedSearch={props.normalizedSearch}
          onBrowsePath={props.onBrowsePath}
          onOpenEntryMenu={openEntryMenu}
          onCollapsedChange={setCollapsed}
          listHeader={
            <WorkspacePickerListHeader
              styles={styles}
              theme={theme}
              screenFocusRef={props.screenFocusRef}
              titleAnchorRef={titleAnchorRef}
              currentFolderTitle={props.currentFolderTitle}
              onOpenPathMenu={() => openPathMenu(titleAnchorRef.current)}
              searchQuery={props.searchQuery}
              setSearchQuery={props.setSearchQuery}
              bridgeRoot={props.bridgeRoot}
              selectedPath={props.selectedPath}
              onSelectPath={props.onSelectPath}
              favoriteWorkspaces={props.favoriteWorkspaces}
              pendingSelectionPath={props.pendingSelectionPath}
              onBrowsePath={props.onBrowsePath}
              onToggleFavorite={props.onToggleFavorite}
              folderCountLabel={folderCountLabel}
            />
          }
          listFooter={
            <WorkspacePickerListFooter
              styles={styles}
              error={props.error}
              refreshError={props.refreshError}
              truncationMessage={props.truncationMessage}
              hint={hint}
            />
          }
        />
        <WorkspacePickerToolbar
          styles={styles}
          footerPath={props.footerPath}
          footerTitle={props.footerTitle}
          footerSubtitle={props.footerSubtitle}
          onSelectPath={props.onSelectPath}
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
    </View>
  );
}
