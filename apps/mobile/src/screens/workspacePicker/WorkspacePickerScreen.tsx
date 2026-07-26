import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';

import { WorkspacePicker } from '../../components/WorkspacePicker';
import { defaultStartCwdAtom } from '../../state/appState/settings';
import { gitCheckoutParentPathAtom } from '../../state/mainScreen/gitCheckout';
import {
  browseWorkspacePathAtom,
  closeWorkspacePickerAtom,
  loadWorkspaceFavoritesAtom,
  openGitCheckoutAtom,
  selectWorkspaceAtom,
  toggleWorkspaceFavoriteAtom,
} from '../../state/mainScreen/workspaceActions';
import {
  favoriteWorkspacePathsAtom,
  loadingWorkspaceBrowseAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseEntriesAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
  workspaceBrowseTruncationAtom,
  workspacePickerPurposeAtom,
  workspaceRootsAtom,
} from '../../state/mainScreen/workspace';
import { normalizeWorkspacePath } from '../main/mainScreenHelpers';

export function WorkspacePickerScreen() {
  const purpose = useAtomValue(workspacePickerPurposeAtom);
  const bridgeRoot = useAtomValue(workspaceBridgeRootAtom);
  const recentWorkspaces = useAtomValue(workspaceRootsAtom);
  const favoriteWorkspacePaths = useAtomValue(favoriteWorkspacePathsAtom);
  const currentPath = useAtomValue(workspaceBrowsePathAtom);
  const parentPath = useAtomValue(workspaceBrowseParentPathAtom);
  const entries = useAtomValue(workspaceBrowseEntriesAtom);
  const loadingEntries = useAtomValue(loadingWorkspaceBrowseAtom);
  const error = useAtomValue(workspaceBrowseErrorAtom);
  const truncationMessage = useAtomValue(workspaceBrowseTruncationAtom);
  const defaultStartCwd = useAtomValue(defaultStartCwdAtom);
  const gitCheckoutParentPath = useAtomValue(gitCheckoutParentPathAtom);
  const browsePath = useSetAtom(browseWorkspacePathAtom);
  const selectWorkspace = useSetAtom(selectWorkspaceAtom);
  const toggleFavorite = useSetAtom(toggleWorkspaceFavoriteAtom);
  const loadFavorites = useSetAtom(loadWorkspaceFavoritesAtom);
  const openGitCheckout = useSetAtom(openGitCheckoutAtom);
  const closePicker = useSetAtom(closeWorkspacePickerAtom);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  const isGitCheckoutDestination = purpose === 'git-checkout-destination';

  return (
    <WorkspacePicker
      selectedPath={
        isGitCheckoutDestination
          ? gitCheckoutParentPath
          : normalizeWorkspacePath(defaultStartCwd)
      }
      bridgeRoot={bridgeRoot}
      recentWorkspaces={recentWorkspaces}
      favoriteWorkspacePaths={favoriteWorkspacePaths}
      currentPath={currentPath}
      parentPath={parentPath}
      entries={entries}
      loadingEntries={loadingEntries}
      error={error}
      truncationMessage={truncationMessage}
      onBrowsePath={(path) => void browsePath(path)}
      onSelectPath={(path) => selectWorkspace(path)}
      onToggleFavorite={(path) => toggleFavorite(path)}
      actionLabel={isGitCheckoutDestination ? null : 'Clone Repo'}
      actionDescription={isGitCheckoutDestination ? null : 'Into this workspace'}
      onActionPress={isGitCheckoutDestination ? undefined : (path) => openGitCheckout(path)}
      onClose={() => closePicker()}
    />
  );
}
