import { useEffect, useMemo, useRef, useState } from 'react';
import type { Text } from 'react-native';

import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../accessibility';
import { feedback } from '../feedback';
import { useAppTheme } from '../theme';
import { matchesSearch, toPathBasename } from './workspacePickerHelpers';
import { WorkspacePickerView } from './WorkspacePickerView';
import { createWorkspacePickerStyles } from './workspacePickerStyles';
import type { WorkspacePickerProps } from './workspacePickerTypes';

function resolveWorkspacePickerFooterInfo(
  pendingSelectionPath: string | null,
  currentPath: string | null,
  bridgeRoot: string | null,
  favoritePathSet: Set<string>,
): {
  footerPath: string | null;
  footerTitle: string;
  currentFolderPath: string | null;
  currentFolderTitle: string;
  footerSubtitle: string;
  footerIsFavorite: boolean;
} {
  const footerPath = pendingSelectionPath ?? currentPath ?? bridgeRoot ?? null;
  const currentFolderPath = currentPath ?? bridgeRoot ?? null;
  return {
    footerPath,
    footerTitle: footerPath ? toPathBasename(footerPath) : 'Default workspace',
    currentFolderPath,
    currentFolderTitle: currentFolderPath ? toPathBasename(currentFolderPath) : 'Loading',
    footerSubtitle: footerPath ?? 'Bridge default workspace',
    footerIsFavorite: footerPath ? favoritePathSet.has(footerPath) : false,
  };
}

function createToggleFavoriteHandler(
  onToggleFavorite: WorkspacePickerProps['onToggleFavorite'],
): ((path: string | null) => void) | undefined {
  if (!onToggleFavorite) return undefined;
  return (path: string | null) => {
    void feedback.selection();
    onToggleFavorite(path);
  };
}

function createActionPressHandler(
  onActionPress: WorkspacePickerProps['onActionPress'],
  footerPath: string | null,
): (() => void) | undefined {
  if (!onActionPress) return undefined;
  return () => {
    void feedback.selection();
    onActionPress(footerPath);
  };
}

interface NormalizedWorkspacePickerProps {
  selectedPath: string | null;
  bridgeRoot: string | null;
  recentWorkspaces: WorkspacePickerProps['recentWorkspaces'];
  favoriteWorkspacePaths: string[];
  currentPath: string | null;
  parentPath: string | null;
  entries: WorkspacePickerProps['entries'];
  loadingEntries: boolean;
  error: string | null;
  refreshError: string | null;
  truncationMessage: string | null;
  onBrowsePath: WorkspacePickerProps['onBrowsePath'];
  onSelectPath: WorkspacePickerProps['onSelectPath'];
  onToggleFavorite: WorkspacePickerProps['onToggleFavorite'];
  actionLabel: string | null;
  actionDescription: string | null;
  actionDisabled: boolean;
  onActionPress: WorkspacePickerProps['onActionPress'];
  onClose: () => void;
}

function normalizeWorkspacePickerProps(
  props: WorkspacePickerProps,
): NormalizedWorkspacePickerProps {
  return {
    selectedPath: props.selectedPath ?? null,
    bridgeRoot: props.bridgeRoot ?? null,
    recentWorkspaces: props.recentWorkspaces,
    favoriteWorkspacePaths: props.favoriteWorkspacePaths ?? [],
    currentPath: props.currentPath ?? null,
    parentPath: props.parentPath ?? null,
    entries: props.entries,
    loadingEntries: props.loadingEntries ?? false,
    error: props.error ?? null,
    refreshError: props.refreshError ?? null,
    truncationMessage: props.truncationMessage ?? null,
    onBrowsePath: props.onBrowsePath,
    onSelectPath: props.onSelectPath,
    onToggleFavorite: props.onToggleFavorite,
    actionLabel: props.actionLabel ?? null,
    actionDescription: props.actionDescription ?? null,
    actionDisabled: props.actionDisabled ?? false,
    onActionPress: props.onActionPress,
    onClose: props.onClose,
  };
}

export function WorkspacePicker(props: WorkspacePickerProps) {
  const {
    selectedPath,
    bridgeRoot,
    recentWorkspaces,
    favoriteWorkspacePaths,
    currentPath,
    parentPath,
    entries,
    loadingEntries,
    error,
    refreshError,
    truncationMessage,
    onBrowsePath,
    onSelectPath,
    onToggleFavorite,
    actionLabel,
    actionDescription,
    actionDisabled,
    onActionPress,
    onClose,
  } = normalizeWorkspacePickerProps(props);
  const theme = useAppTheme();
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingSelectionPath, setPendingSelectionPath] = useState<string | null>(
    selectedPath ?? currentPath ?? bridgeRoot,
  );
  const previousSelectedPathRef = useRef<string | null>(selectedPath);
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);

  useEffect(() => {
    if (pendingSelectionPath !== null) return;
    const fallbackPath = selectedPath ?? currentPath ?? bridgeRoot;
    if (fallbackPath) setPendingSelectionPath(fallbackPath);
  }, [bridgeRoot, currentPath, pendingSelectionPath, selectedPath]);

  useEffect(() => {
    const previousSelectedPath = previousSelectedPathRef.current;
    previousSelectedPathRef.current = selectedPath;
    if (previousSelectedPath === selectedPath) return;
    setPendingSelectionPath((current) =>
      current !== previousSelectedPath
        ? current
        : (selectedPath ?? currentPath ?? bridgeRoot ?? null),
    );
  }, [bridgeRoot, currentPath, selectedPath]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const favoritePathSet = useMemo(() => new Set(favoriteWorkspacePaths), [favoriteWorkspacePaths]);
  const recentWorkspaceByPath = useMemo(
    () => new Map(recentWorkspaces.map((workspace) => [workspace.path, workspace])),
    [recentWorkspaces],
  );
  const favoriteWorkspaces = favoriteWorkspacePaths
    .map((path) => recentWorkspaceByPath.get(path) ?? { path, chatCount: 0 })
    .filter((workspace) =>
      matchesSearch([workspace.path, toPathBasename(workspace.path)], normalizedSearch),
    )
    .slice(0, 4);
  const filteredEntries = entries.filter((entry) =>
    matchesSearch([entry.name, entry.path], normalizedSearch),
  );
  const {
    footerPath,
    footerTitle,
    currentFolderPath,
    currentFolderTitle,
    footerSubtitle,
    footerIsFavorite,
  } = resolveWorkspacePickerFooterInfo(
    pendingSelectionPath,
    currentPath,
    bridgeRoot,
    favoritePathSet,
  );
  const screenFocusRef = useModalAccessibilityFocus<Text>(true);
  useAccessibilityAnnouncement(error ?? truncationMessage);
  useAccessibilityAnnouncement(refreshError);
  useAccessibilityAnnouncement(loadingEntries ? `Loading folders in ${currentFolderTitle}` : null);

  const handleClose = () => {
    void feedback.selection();
    onClose();
  };

  const handleBrowsePath = (path: string | null) => {
    void feedback.selection();
    setPendingSelectionPath(path);
    onBrowsePath(path);
  };

  const handleSelectPath = (path: string | null) => {
    void feedback.selection();
    onSelectPath(path);
  };

  const handleToggleFavorite = createToggleFavoriteHandler(onToggleFavorite);
  const handleActionPress = createActionPressHandler(onActionPress, footerPath);

  return (
    <WorkspacePickerView
      styles={styles}
      theme={theme}
      screenFocusRef={screenFocusRef}
      onClose={handleClose}
      selectedPath={selectedPath}
      bridgeRoot={bridgeRoot}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      onSelectPath={handleSelectPath}
      actionLabel={actionLabel}
      actionDescription={actionDescription}
      actionDisabled={actionDisabled}
      onActionPress={handleActionPress}
      favoriteWorkspaces={favoriteWorkspaces}
      favoritePathSet={favoritePathSet}
      pendingSelectionPath={pendingSelectionPath}
      onBrowsePath={handleBrowsePath}
      onToggleFavorite={handleToggleFavorite}
      parentPath={parentPath}
      loadingEntries={loadingEntries}
      filteredEntries={filteredEntries}
      normalizedSearch={normalizedSearch}
      currentFolderTitle={currentFolderTitle}
      currentFolderPath={currentFolderPath}
      error={error}
      refreshError={refreshError}
      truncationMessage={truncationMessage}
      footerPath={footerPath}
      footerTitle={footerTitle}
      footerSubtitle={footerSubtitle}
      footerIsFavorite={footerIsFavorite}
    />
  );
}
