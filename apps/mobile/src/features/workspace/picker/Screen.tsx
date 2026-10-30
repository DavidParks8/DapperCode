import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';

import { WorkspacePicker } from './Picker';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { activeProfileFeaturesAtom } from '@shell/state/bridge/atoms';
import {
  gitCheckoutParentPathAtom,
  resumeGitCheckoutAfterWorkspacePickerAtom,
} from '../state/gitCheckout';
import {
  browseWorkspacePathAtom,
  closeWorkspacePickerAtom,
  openGitCheckoutAtom,
  revalidateWorkspacePickerResourcesAtom,
  selectWorkspaceAtom,
  toggleWorkspaceFavoriteAtom,
} from '../state/workspaceActions';
import {
  favoriteWorkspacePathsAtom,
  workspaceFavoritesRefreshErrorAtom,
  loadingWorkspaceBrowseAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseEntriesAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
  workspaceBrowseTruncationAtom,
  workspacePickerPurposeAtom,
  workspaceRootsAtom,
  workspaceRootsRefreshErrorAtom,
} from '../state/workspace';
import { normalizeWorkspacePath } from '../../chat/helpers/helpers';

export function WorkspacePickerScreen() {
  const purpose = useAtomValue(workspacePickerPurposeAtom);
  const bridgeRoot = useAtomValue(workspaceBridgeRootAtom);
  const recentWorkspaces = useAtomValue(workspaceRootsAtom);
  const favoriteWorkspacePaths = useAtomValue(favoriteWorkspacePathsAtom);
  const favoritesRefreshError = useAtomValue(workspaceFavoritesRefreshErrorAtom);
  const currentPath = useAtomValue(workspaceBrowsePathAtom);
  const parentPath = useAtomValue(workspaceBrowseParentPathAtom);
  const entries = useAtomValue(workspaceBrowseEntriesAtom);
  const loadingEntries = useAtomValue(loadingWorkspaceBrowseAtom);
  const error = useAtomValue(workspaceBrowseErrorAtom);
  const truncationMessage = useAtomValue(workspaceBrowseTruncationAtom);
  const rootsRefreshError = useAtomValue(workspaceRootsRefreshErrorAtom);
  const defaultStartCwd = useAtomValue(defaultStartCwdAtom);
  const gitCheckoutParentPath = useAtomValue(gitCheckoutParentPathAtom);
  const browsePath = useSetAtom(browseWorkspacePathAtom);
  const selectWorkspace = useSetAtom(selectWorkspaceAtom);
  const toggleFavorite = useSetAtom(toggleWorkspaceFavoriteAtom);
  const revalidateResources = useSetAtom(revalidateWorkspacePickerResourcesAtom);
  const openGitCheckout = useSetAtom(openGitCheckoutAtom);
  const closePicker = useSetAtom(closeWorkspacePickerAtom);
  const setResumeGitCheckout = useSetAtom(resumeGitCheckoutAfterWorkspacePickerAtom);

  useEffect(() => {
    void revalidateResources();
    return () => setResumeGitCheckout(false);
  }, [revalidateResources, setResumeGitCheckout]);

  const isGitCheckoutDestination = purpose === 'git-checkout-destination';
  const cloneAvailable =
    useAtomValue(activeProfileFeaturesAtom).gitClone && !isGitCheckoutDestination;

  return (
    <WorkspacePicker
      selectedPath={
        isGitCheckoutDestination ? gitCheckoutParentPath : normalizeWorkspacePath(defaultStartCwd)
      }
      bridgeRoot={bridgeRoot}
      recentWorkspaces={recentWorkspaces}
      favoriteWorkspacePaths={favoriteWorkspacePaths}
      currentPath={currentPath}
      parentPath={parentPath}
      entries={entries}
      loadingEntries={loadingEntries}
      error={error}
      refreshError={
        rootsRefreshError
          ? "Recent workspaces couldn't be refreshed. You can keep browsing folders."
          : favoritesRefreshError
            ? "Pinned workspaces couldn't be saved. Try again after reconnecting."
            : null
      }
      truncationMessage={truncationMessage}
      onBrowsePath={(path) => void browsePath(path)}
      onSelectPath={(path) => selectWorkspace(path)}
      onToggleFavorite={(path) => toggleFavorite(path)}
      actionLabel={cloneAvailable ? 'Clone Repo' : null}
      actionDescription={cloneAvailable ? 'Into this workspace' : null}
      onActionPress={cloneAvailable ? (path) => openGitCheckout(path) : undefined}
      onClose={() => closePicker()}
    />
  );
}
