import { atom } from 'jotai';

import type { FileSystemListResponse } from '../../api/types';
import { MainScreenPersistenceController } from '../../screens/main/controllers/mainScreenPersistenceController';
import {
  deriveCloneDirectoryName,
  formatGitCloneFailureMessage,
  getWorkspaceBrowseCacheKey,
  joinWorkspacePath,
  normalizeCloneDirectoryName,
  normalizeWorkspacePath,
  scheduleIdleTask,
  WORKSPACE_FAVORITES_LIMIT,
  type WorkspacePickerPurpose,
} from '../../screens/main/mainScreenHelpers';
import { defaultStartCwdAtom } from '../appState/settings';
import { apiClientAtom } from '../bridge/atoms';
import { currentScreenAtom, toAppScreen } from '../navigation/atoms';
import {
  gitCheckoutCloningAtom,
  gitCheckoutDirectoryNameAtom,
  gitCheckoutDirectoryNameEditedAtom,
  gitCheckoutErrorAtom,
  gitCheckoutParentPathAtom,
  gitCheckoutRepoUrlAtom,
  resumeGitCheckoutAfterWorkspacePickerAtom,
} from './gitCheckout';
import {
  favoriteWorkspacePathsAtom,
  workspaceBrowseCacheAtom,
  workspaceBrowseRequestIdAtom,
  workspacePickerReturnScreenAtom,
  loadingWorkspaceBrowseAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseEntriesAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
  workspaceBrowseTruncationAtom,
  workspacePickerPurposeAtom,
  workspaceRootsAtom,
} from './workspace';

/**
 * Workspace browsing and git checkout as store actions.
 *
 * Both flows are full screens now, and a screen only exists while it is the current one, so the
 * behaviour cannot live in MainScreen callbacks. Keeping it in write-only atoms means MainScreen,
 * WorkspacePickerScreen, and GitCheckoutScreen all drive the same implementation.
 */

const favoritesPersistence = new MainScreenPersistenceController();

export const loadWorkspaceFavoritesAtom = atom(null, async (get, set): Promise<void> => {
  set(favoriteWorkspacePathsAtom, await favoritesPersistence.loadWorkspaceFavorites());
});

export const toggleWorkspaceFavoriteAtom = atom(
  null,
  (get, set, path: string | null | undefined): void => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return;
    }

    const current = get(favoriteWorkspacePathsAtom);
    const next = current.includes(normalizedPath)
      ? current.filter((entry) => entry !== normalizedPath)
      : [normalizedPath, ...current.filter((entry) => entry !== normalizedPath)].slice(
          0,
          WORKSPACE_FAVORITES_LIMIT
        );
    set(favoriteWorkspacePathsAtom, next);
    void favoritesPersistence.saveWorkspaceFavorites(next);
  }
);

export const refreshWorkspaceRootsAtom = atom(
  null,
  async (get, set): Promise<{ bridgeRoot: string | null } | null> => {
    const api = get(apiClientAtom);
    if (!api) {
      return null;
    }
    try {
      const response = await api.listWorkspaceRoots();
      set(workspaceBridgeRootAtom, normalizeWorkspacePath(response.bridgeRoot));
      set(workspaceRootsAtom, response.workspaces);
      set(workspaceBrowseErrorAtom, null);
      return response;
    } catch (err) {
      set(workspaceBrowseErrorAtom, (err as Error).message);
      return null;
    }
  }
);

export const browseWorkspacePathAtom = atom(
  null,
  async (get, set, path: string | null | undefined): Promise<void> => {
    const api = get(apiClientAtom);
    if (!api) {
      return;
    }
    const normalizedRequestPath = normalizeWorkspacePath(path);
    const cacheKey = getWorkspaceBrowseCacheKey(normalizedRequestPath);
    const cache = get(workspaceBrowseCacheAtom);
    const cached = cache[cacheKey];
    const requestId = get(workspaceBrowseRequestIdAtom) + 1;
    set(workspaceBrowseRequestIdAtom, requestId);

    const applyResponse = (response: FileSystemListResponse, responseCacheKey = cacheKey) => {
      const normalizedPath = normalizeWorkspacePath(response.path);
      const nextCache = { ...get(workspaceBrowseCacheAtom), [responseCacheKey]: response };
      if (normalizedPath) {
        nextCache[getWorkspaceBrowseCacheKey(normalizedPath)] = response;
      }
      set(workspaceBrowseCacheAtom, nextCache);
      set(workspaceBridgeRootAtom, (current) =>
        normalizeWorkspacePath(response.bridgeRoot) ?? current
      );
      set(workspaceBrowsePathAtom, normalizedPath);
      set(workspaceBrowseParentPathAtom, normalizeWorkspacePath(response.parentPath));
      set(workspaceBrowseEntriesAtom, response.entries);
      set(
        workspaceBrowseTruncationAtom,
        response.truncated
          ? `Showing ${String(response.entries.length)} of ${String(response.totalEntries)} entries.`
          : null
      );
    };

    if (cached) {
      set(workspaceBridgeRootAtom, (current) =>
        normalizeWorkspacePath(cached.bridgeRoot) ?? current
      );
      set(workspaceBrowsePathAtom, normalizeWorkspacePath(cached.path));
      set(workspaceBrowseParentPathAtom, normalizeWorkspacePath(cached.parentPath));
      set(workspaceBrowseEntriesAtom, cached.entries);
      set(
        workspaceBrowseTruncationAtom,
        cached.truncated
          ? `Showing ${String(cached.entries.length)} of ${String(cached.totalEntries)} entries.`
          : null
      );
      set(workspaceBrowseErrorAtom, null);
    }

    set(loadingWorkspaceBrowseAtom, true);
    try {
      const response = await api.listFilesystemEntries({
        path: normalizedRequestPath,
        directoriesOnly: true,
      });
      if (get(workspaceBrowseRequestIdAtom) !== requestId) {
        return;
      }

      applyResponse(response);
      set(workspaceBrowseErrorAtom, null);
    } catch (err) {
      if (get(workspaceBrowseRequestIdAtom) !== requestId) {
        return;
      }
      const message = (err as Error).message;
      const missingRequestedWorkspace =
        normalizedRequestPath !== null &&
        /workspace directory is invalid or inaccessible|workspace directory must point to a folder/i.test(
          message
        );

      if (missingRequestedWorkspace) {
        try {
          const rootResponse = await api.listFilesystemEntries({
            path: null,
            directoriesOnly: true,
          });
          if (get(workspaceBrowseRequestIdAtom) !== requestId) {
            return;
          }
          applyResponse(
            rootResponse,
            getWorkspaceBrowseCacheKey(normalizeWorkspacePath(rootResponse.path))
          );
          if (normalizedRequestPath === normalizeWorkspacePath(get(defaultStartCwdAtom))) {
            set(defaultStartCwdAtom, null);
          }
          set(workspaceBrowseErrorAtom, 'Saved workspace was not found. Showing start folder.');
          return;
        } catch {
          // Surface the original invalid path error; it names the path the user needs to fix.
        }
      }

      set(workspaceBrowseErrorAtom, message);
    } finally {
      if (get(workspaceBrowseRequestIdAtom) === requestId) {
        set(loadingWorkspaceBrowseAtom, false);
      }
    }
  }
);

export const openWorkspacePickerAtom = atom(
  null,
  (
    get,
    set,
    purpose: WorkspacePickerPurpose,
    initialPathOverride?: string | null
  ): void => {
    const initialPath =
      normalizeWorkspacePath(initialPathOverride) ??
      normalizeWorkspacePath(get(defaultStartCwdAtom)) ??
      get(workspaceBrowsePathAtom) ??
      get(workspaceBridgeRootAtom) ??
      null;
    set(workspacePickerPurposeAtom, purpose);
    if (purpose !== 'git-checkout-destination') {
      set(workspacePickerReturnScreenAtom, toAppScreen(get(currentScreenAtom)));
    }
    set(currentScreenAtom, 'WorkspacePicker');
    void set(browseWorkspacePathAtom, initialPath);
    scheduleIdleTask(() => {
      void set(refreshWorkspaceRootsAtom);
    });
  }
);

export const openWorkspaceModalAtom = atom(null, (get, set): void => {
  set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
  set(openWorkspacePickerAtom, 'default-start');
});

export const closeWorkspacePickerAtom = atom(null, (get, set): void => {
  if (
    get(workspacePickerPurposeAtom) === 'git-checkout-destination' &&
    get(resumeGitCheckoutAfterWorkspacePickerAtom)
  ) {
    set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
    set(currentScreenAtom, 'GitCheckout');
    return;
  }
  set(currentScreenAtom, get(workspacePickerReturnScreenAtom));
});

export const selectWorkspaceAtom = atom(null, (get, set, cwd: string | null): void => {
  const normalizedPath = normalizeWorkspacePath(cwd);
  set(workspaceBrowseErrorAtom, null);

  if (get(workspacePickerPurposeAtom) === 'git-checkout-destination') {
    set(gitCheckoutParentPathAtom, normalizedPath);
    set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
    set(currentScreenAtom, 'GitCheckout');
    return;
  }

  set(defaultStartCwdAtom, normalizedPath);
  set(currentScreenAtom, get(workspacePickerReturnScreenAtom));
});

export const openGitCheckoutAtom = atom(
  null,
  (get, set, initialParentPath?: string | null): void => {
    const defaultParentPath =
      normalizeWorkspacePath(initialParentPath) ??
      normalizeWorkspacePath(get(defaultStartCwdAtom)) ??
      get(workspaceBrowsePathAtom) ??
      get(workspaceBridgeRootAtom) ??
      null;
    set(gitCheckoutRepoUrlAtom, '');
    set(gitCheckoutDirectoryNameAtom, '');
    set(gitCheckoutDirectoryNameEditedAtom, false);
    set(gitCheckoutParentPathAtom, defaultParentPath);
    set(gitCheckoutErrorAtom, null);
    set(gitCheckoutCloningAtom, false);
    set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
    set(currentScreenAtom, 'GitCheckout');
    void set(refreshWorkspaceRootsAtom).then((response) => {
      const bridgeRoot = normalizeWorkspacePath(response?.bridgeRoot);
      if (bridgeRoot) {
        set(gitCheckoutParentPathAtom, (current) => current ?? bridgeRoot);
      }
    });
  }
);

export const closeGitCheckoutAtom = atom(null, (get, set): void => {
  if (get(gitCheckoutCloningAtom)) {
    return;
  }
  set(gitCheckoutErrorAtom, null);
  set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
  set(currentScreenAtom, 'Main');
});

export const openGitCheckoutDestinationPickerAtom = atom(null, (get, set): void => {
  set(resumeGitCheckoutAfterWorkspacePickerAtom, true);
  set(
    openWorkspacePickerAtom,
    'git-checkout-destination',
    get(gitCheckoutParentPathAtom) ??
      normalizeWorkspacePath(get(defaultStartCwdAtom)) ??
      get(workspaceBridgeRootAtom) ??
      null
  );
});

export const changeGitCheckoutRepoUrlAtom = atom(null, (get, set, value: string): void => {
  set(gitCheckoutRepoUrlAtom, value);
  set(gitCheckoutErrorAtom, null);
  if (!get(gitCheckoutDirectoryNameEditedAtom)) {
    set(gitCheckoutDirectoryNameAtom, deriveCloneDirectoryName(value) ?? '');
  }
});

export const changeGitCheckoutDirectoryNameAtom = atom(null, (get, set, value: string): void => {
  set(gitCheckoutDirectoryNameAtom, value);
  set(gitCheckoutDirectoryNameEditedAtom, value.trim().length > 0);
  set(gitCheckoutErrorAtom, null);
});

export const submitGitCheckoutAtom = atom(null, async (get, set): Promise<void> => {
  const api = get(apiClientAtom);
  const url = get(gitCheckoutRepoUrlAtom).trim();
  const directoryName = normalizeCloneDirectoryName(get(gitCheckoutDirectoryNameAtom));
  if (!url) {
    set(gitCheckoutErrorAtom, 'Paste an HTTPS or SSH repository URL first.');
    return;
  }
  if (!directoryName) {
    set(gitCheckoutErrorAtom, 'Choose a valid folder name for the cloned repo.');
    return;
  }

  let parentPath =
    normalizeWorkspacePath(get(gitCheckoutParentPathAtom)) ?? get(workspaceBridgeRootAtom);
  if (!parentPath) {
    const response = await set(refreshWorkspaceRootsAtom);
    parentPath = normalizeWorkspacePath(response?.bridgeRoot);
  }
  if (!parentPath || !api) {
    set(gitCheckoutErrorAtom, 'Choose where the repository should be cloned.');
    return;
  }

  try {
    set(gitCheckoutCloningAtom, true);
    set(gitCheckoutErrorAtom, null);
    const cloned = await api.gitClone({ url, parentPath, directoryName });
    const cloneFailureMessage = formatGitCloneFailureMessage(cloned, directoryName);
    if (cloneFailureMessage) {
      set(gitCheckoutErrorAtom, cloneFailureMessage);
      return;
    }
    const clonedPath =
      normalizeWorkspacePath(cloned.cwd) ?? joinWorkspacePath(parentPath, directoryName);
    set(defaultStartCwdAtom, clonedPath);
    set(workspaceBrowsePathAtom, clonedPath);
    set(workspaceBrowseParentPathAtom, parentPath);
    set(workspaceBrowseErrorAtom, null);
    set(currentScreenAtom, 'Main');
  } catch (err) {
    set(gitCheckoutErrorAtom, (err as Error).message);
  } finally {
    set(gitCheckoutCloningAtom, false);
  }
});
