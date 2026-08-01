import { useEffect, useMemo, useRef, useState } from 'react';
import type { Text } from 'react-native';

import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../accessibility';
import { feedback } from '../feedback';
import { useAppTheme } from '../theme';
import { matchesSearch, toPathBasename } from './workspacePickerHelpers';
import { WorkspacePickerView } from './WorkspacePickerView';
import { createWorkspacePickerStyles } from './workspacePickerStyles';
import type { WorkspacePickerProps } from './workspacePickerTypes';

export function WorkspacePicker({
  selectedPath = null,
  bridgeRoot = null,
  recentWorkspaces,
  favoriteWorkspacePaths = [],
  currentPath = null,
  parentPath = null,
  entries,
  loadingEntries = false,
  error = null,
  refreshError = null,
  truncationMessage = null,
  onBrowsePath,
  onSelectPath,
  onToggleFavorite,
  actionLabel = null,
  actionDescription = null,
  actionDisabled = false,
  onActionPress,
  onClose,
}: WorkspacePickerProps) {
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
  const footerPath = pendingSelectionPath ?? currentPath ?? bridgeRoot ?? null;
  const footerTitle = footerPath ? toPathBasename(footerPath) : 'Default workspace';
  const currentFolderPath = currentPath ?? bridgeRoot ?? null;
  const currentFolderTitle = currentFolderPath ? toPathBasename(currentFolderPath) : 'Loading';
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

  const handleToggleFavorite = onToggleFavorite
    ? (path: string | null) => {
        void feedback.selection();
        onToggleFavorite(path);
      }
    : undefined;

  const handleActionPress = onActionPress
    ? () => {
        void feedback.selection();
        onActionPress(footerPath);
      }
    : undefined;

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
      footerSubtitle={footerPath ?? 'Bridge default workspace'}
      footerIsFavorite={footerPath ? favoritePathSet.has(footerPath) : false}
    />
  );
}
