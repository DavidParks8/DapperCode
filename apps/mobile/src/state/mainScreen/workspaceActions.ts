import { atom } from 'jotai';
import { router } from 'expo-router';

import type { HostBridgeApiClient } from '../../api/client';
import type { FileSystemListResponse, WorkspaceListResponse } from '../../api/types';
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
import { activeBridgeProfileAtom, apiClientAtom } from '../bridge/atoms';
import { routes } from '../../navigation/routes';
import { getWorkspaceRouteIds, returnToChat } from './workspaceRouteNavigation';
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
  activeWorkspaceIdentityAtom,
  workspaceFavoritesByProfileAtom,
  workspaceFavoritesResourceAtom,
  workspaceBrowseCacheAtom,
  workspaceBrowseDisplayIdentityKeyAtom,
  workspaceBrowseRequestIdAtom,
  loadingWorkspaceBrowseAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseEntriesAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
  workspaceBrowseTruncationAtom,
  workspacePickerPurposeAtom,
  workspaceRootsByProfileAtom,
  workspaceRootsResourceAtom,
} from './workspace';

/**
 * Workspace browsing and git checkout as store actions.
 *
 * Both flows are full screens now, and a screen only exists while it is the current one, so the
 * behaviour cannot live in MainScreen callbacks. Keeping it in write-only atoms means MainScreen,
 * WorkspacePickerScreen, and GitCheckoutScreen all drive the same implementation.
 */

const favoritesPersistenceByProfile = new Map<string, MainScreenPersistenceController>();
type WorkspaceRootsResult = Omit<
  Pick<WorkspaceListResponse, 'bridgeRoot' | 'workspaces'>,
  'bridgeRoot'
> & { bridgeRoot: string | null };

const rootsRequestsByApi = new WeakMap<object, Map<string, Promise<WorkspaceRootsResult | null>>>();
const favoritesRequestsByPersistence = new WeakMap<
  MainScreenPersistenceController,
  Promise<void>
>();

export const WORKSPACE_RESOURCES_TTL_MS = 30_000;

export interface WorkspaceResourceRevalidationOptions {
  force?: boolean;
  now?: number;
  ttlMs?: number;
}

function shouldUseFreshResource(
  fetchedAt: number | null,
  {
    force = false,
    now = Date.now(),
    ttlMs = WORKSPACE_RESOURCES_TTL_MS,
  }: WorkspaceResourceRevalidationOptions,
): boolean {
  return !force && fetchedAt !== null && now - fetchedAt < ttlMs;
}

function getFavoritesPersistence(profileId: string): MainScreenPersistenceController {
  let persistence = favoritesPersistenceByProfile.get(profileId);
  if (!persistence) {
    persistence = new MainScreenPersistenceController({ profileId });
    favoritesPersistenceByProfile.set(profileId, persistence);
  }
  return persistence;
}

export const loadWorkspaceFavoritesAtom = atom(
  null,
  async (get, set, options: WorkspaceResourceRevalidationOptions = {}): Promise<void> => {
    const profileId = get(activeBridgeProfileAtom)?.id;
    if (!profileId) return;
    const current = get(workspaceFavoritesResourceAtom);
    if (shouldUseFreshResource(current.fetchedAt, options)) return;

    const persistence = getFavoritesPersistence(profileId);
    const existing = favoritesRequestsByPersistence.get(persistence);
    if (existing) return existing;

    const requestId = current.requestId + 1;
    set(workspaceFavoritesByProfileAtom, (resources) => ({
      ...resources,
      [profileId]: { ...current, error: null, refreshing: true, requestId },
    }));
    const request = persistence
      .loadWorkspaceFavorites()
      .then((paths) => {
        const latest = get(workspaceFavoritesByProfileAtom)[profileId];
        if (!latest || latest.requestId !== requestId) return;
        set(workspaceFavoritesByProfileAtom, (resources) => ({
          ...resources,
          [profileId]: {
            ...latest,
            data: paths,
            error: null,
            fetchedAt: options.now ?? Date.now(),
            refreshing: false,
          },
        }));
      })
      .catch((error: Error) => {
        const latest = get(workspaceFavoritesByProfileAtom)[profileId];
        if (!latest || latest.requestId !== requestId) return;
        set(workspaceFavoritesByProfileAtom, (resources) => ({
          ...resources,
          [profileId]: { ...latest, error: error.message, refreshing: false },
        }));
      })
      .finally(() => {
        if (favoritesRequestsByPersistence.get(persistence) === request) {
          favoritesRequestsByPersistence.delete(persistence);
        }
      });
    favoritesRequestsByPersistence.set(persistence, request);
    return request;
  },
);

export const toggleWorkspaceFavoriteAtom = atom(
  null,
  (get, set, path: string | null | undefined): void => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return;
    }

    const profileId = get(activeBridgeProfileAtom)?.id;
    if (!profileId) return;
    const current = get(workspaceFavoritesResourceAtom);
    const next = current.data.includes(normalizedPath)
      ? current.data.filter((entry) => entry !== normalizedPath)
      : [normalizedPath, ...current.data.filter((entry) => entry !== normalizedPath)].slice(
          0,
          WORKSPACE_FAVORITES_LIMIT,
        );
    set(workspaceFavoritesByProfileAtom, (resources) => ({
      ...resources,
      [profileId]: {
        ...current,
        data: next,
        error: null,
        fetchedAt: Date.now(),
        refreshing: false,
        requestId: current.requestId + 1,
      },
    }));
    const persistence = getFavoritesPersistence(profileId);
    void persistence.saveWorkspaceFavorites(next).catch((error: Error) =>
      set(workspaceFavoritesByProfileAtom, (resources) => {
        const resource = resources[profileId];
        return resource
          ? { ...resources, [profileId]: { ...resource, error: error.message } }
          : resources;
      }),
    );
  },
);

export const refreshWorkspaceRootsAtom = atom(
  null,
  async (
    get,
    set,
    options: WorkspaceResourceRevalidationOptions = {},
  ): Promise<WorkspaceRootsResult | null> => {
    const identity = get(activeWorkspaceIdentityAtom);
    if (!identity) return null;
    const { profileId, identityKey, client: api } = identity;

    // `workspaceRootsResourceAtom` already returns the empty resource when the cached entry's
    // identity doesn't match, so a bridge fetched under a previous identity can never look fresh.
    const current = get(workspaceRootsResourceAtom);
    if (shouldUseFreshResource(current.fetchedAt, options)) {
      return { bridgeRoot: current.bridgeRoot, workspaces: current.data };
    }

    const requestsForApi = rootsRequestsByApi.get(api) ?? new Map();
    rootsRequestsByApi.set(api, requestsForApi);
    // Keyed by identity (not just profile ID) so an in-flight request from a bridge/token that
    // was edited out from under it is never mistaken for the same-identity single-flight request.
    const existing = requestsForApi.get(identityKey);
    if (existing) return existing;

    const requestId = current.requestId + 1;
    set(workspaceRootsByProfileAtom, (resources) => ({
      ...resources,
      [profileId]: { ...current, identityKey, error: null, refreshing: true, requestId },
    }));
    const request = api
      .listWorkspaceRoots()
      .then((response) => {
        const latest = get(workspaceRootsByProfileAtom)[profileId];
        if (!latest || latest.identityKey !== identityKey || latest.requestId !== requestId) {
          return response;
        }
        set(workspaceRootsByProfileAtom, (resources) => ({
          ...resources,
          [profileId]: {
            ...latest,
            bridgeRoot: normalizeWorkspacePath(response.bridgeRoot),
            data: response.workspaces,
            error: null,
            fetchedAt: options.now ?? Date.now(),
            refreshing: false,
          },
        }));
        return response;
      })
      .catch((err: Error) => {
        const latest = get(workspaceRootsByProfileAtom)[profileId];
        if (latest?.identityKey === identityKey && latest.requestId === requestId) {
          set(workspaceRootsByProfileAtom, (resources) => ({
            ...resources,
            [profileId]: { ...latest, error: err.message, refreshing: false },
          }));
        }
        return null;
      })
      .finally(() => {
        if (requestsForApi.get(identityKey) === request) {
          requestsForApi.delete(identityKey);
        }
      });
    requestsForApi.set(identityKey, request);
    return request;
  },
);

export const revalidateWorkspacePickerResourcesAtom = atom(
  null,
  async (get, set, options: WorkspaceResourceRevalidationOptions = {}): Promise<void> => {
    await Promise.all([
      set(loadWorkspaceFavoritesAtom, options),
      set(refreshWorkspaceRootsAtom, options),
    ]);
  },
);

const browseRequestsByApi = new WeakMap<
  HostBridgeApiClient,
  Map<string, Promise<FileSystemListResponse>>
>();

/** Single-flights identical directory listings so concurrent callers (e.g. opening the picker
 *  while a background revalidation is in flight) share one network request per bridge client. */
function sharedBrowseRequest(
  api: HostBridgeApiClient,
  key: string,
  fetcher: () => Promise<FileSystemListResponse>,
): Promise<FileSystemListResponse> {
  let requests = browseRequestsByApi.get(api);
  if (!requests) {
    requests = new Map();
    browseRequestsByApi.set(api, requests);
  }
  const existing = requests.get(key);
  if (existing) return existing;
  const request = fetcher().finally(() => {
    if (requests?.get(key) === request) {
      requests.delete(key);
    }
  });
  requests.set(key, request);
  return request;
}

export const browseWorkspacePathAtom = atom(
  null,
  async (get, set, path: string | null | undefined): Promise<void> => {
    const identity = get(activeWorkspaceIdentityAtom);
    if (!identity) {
      return;
    }
    const { identityKey, client: api } = identity;
    const normalizedRequestPath = normalizeWorkspacePath(path);
    const cacheKey = getWorkspaceBrowseCacheKey(normalizedRequestPath);
    const cache = get(workspaceBrowseCacheAtom);
    const cached = cache[cacheKey];
    const requestId = get(workspaceBrowseRequestIdAtom) + 1;
    set(workspaceBrowseRequestIdAtom, requestId);
    if (get(workspaceBrowseDisplayIdentityKeyAtom) !== identityKey) {
      set(workspaceBrowseDisplayIdentityKeyAtom, identityKey);
      if (!cached) {
        set(workspaceBrowsePathAtom, normalizedRequestPath);
        set(workspaceBrowseParentPathAtom, null);
        set(workspaceBrowseEntriesAtom, []);
        set(workspaceBrowseTruncationAtom, null);
        set(workspaceBrowseErrorAtom, null);
      }
    }

    const isCurrentRequest = () =>
      get(workspaceBrowseRequestIdAtom) === requestId &&
      get(activeWorkspaceIdentityAtom)?.identityKey === identityKey;

    const applyResponse = (response: FileSystemListResponse, responseCacheKey = cacheKey) => {
      const normalizedPath = normalizeWorkspacePath(response.path);
      const nextCache = { ...get(workspaceBrowseCacheAtom), [responseCacheKey]: response };
      if (normalizedPath) {
        nextCache[getWorkspaceBrowseCacheKey(normalizedPath)] = response;
      }
      set(workspaceBrowseCacheAtom, nextCache);
      set(
        workspaceBridgeRootAtom,
        (current) => normalizeWorkspacePath(response.bridgeRoot) ?? current,
      );
      set(workspaceBrowsePathAtom, normalizedPath);
      set(workspaceBrowseParentPathAtom, normalizeWorkspacePath(response.parentPath));
      set(workspaceBrowseEntriesAtom, response.entries);
      set(
        workspaceBrowseTruncationAtom,
        response.truncated
          ? `Showing ${String(response.entries.length)} of ${String(response.totalEntries)} entries.`
          : null,
      );
    };

    if (cached) {
      set(
        workspaceBridgeRootAtom,
        (current) => normalizeWorkspacePath(cached.bridgeRoot) ?? current,
      );
      set(workspaceBrowsePathAtom, normalizeWorkspacePath(cached.path));
      set(workspaceBrowseParentPathAtom, normalizeWorkspacePath(cached.parentPath));
      set(workspaceBrowseEntriesAtom, cached.entries);
      set(
        workspaceBrowseTruncationAtom,
        cached.truncated
          ? `Showing ${String(cached.entries.length)} of ${String(cached.totalEntries)} entries.`
          : null,
      );
      set(workspaceBrowseErrorAtom, null);
    }

    set(loadingWorkspaceBrowseAtom, true);
    try {
      // The dedup key folds the identity in so a listing kicked off before a profile edit is
      // never mistaken for (or returned to) a caller browsing under the new identity.
      const response = await sharedBrowseRequest(api, `${identityKey}\u0000${cacheKey}`, () =>
        api.listFilesystemEntries({
          path: normalizedRequestPath,
          directoriesOnly: true,
        }),
      );
      if (!isCurrentRequest()) {
        return;
      }

      applyResponse(response);
      set(workspaceBrowseErrorAtom, null);
    } catch (err) {
      if (!isCurrentRequest()) {
        return;
      }
      const message = (err as Error).message;
      const missingRequestedWorkspace =
        normalizedRequestPath !== null &&
        /workspace directory is invalid or inaccessible|workspace directory must point to a folder/i.test(
          message,
        );

      if (missingRequestedWorkspace) {
        try {
          const rootCacheKey = getWorkspaceBrowseCacheKey(null);
          const rootResponse = await sharedBrowseRequest(
            api,
            `${identityKey}\u0000${rootCacheKey}`,
            () =>
              api.listFilesystemEntries({
                path: null,
                directoriesOnly: true,
              }),
          );
          if (!isCurrentRequest()) {
            return;
          }
          applyResponse(
            rootResponse,
            getWorkspaceBrowseCacheKey(normalizeWorkspacePath(rootResponse.path)),
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
      if (isCurrentRequest()) {
        set(loadingWorkspaceBrowseAtom, false);
      }
    }
  },
);

export const openWorkspacePickerAtom = atom(
  null,
  (get, set, purpose: WorkspacePickerPurpose, initialPathOverride?: string | null): void => {
    const { profileId, chatId } = getWorkspaceRouteIds(get);
    if (!profileId) {
      router.replace(routes.onboarding);
      return;
    }
    const initialPath =
      normalizeWorkspacePath(initialPathOverride) ??
      normalizeWorkspacePath(get(defaultStartCwdAtom)) ??
      get(workspaceBrowsePathAtom) ??
      get(workspaceBridgeRootAtom) ??
      null;
    set(workspacePickerPurposeAtom, purpose);
    router.push(routes.workspacePicker(profileId, chatId));
    void set(browseWorkspacePathAtom, initialPath);
    scheduleIdleTask(() => {
      void set(revalidateWorkspacePickerResourcesAtom);
    });
  },
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
    router.back();
    return;
  }
  returnToChat(get);
});

export const selectWorkspaceAtom = atom(null, (get, set, cwd: string | null): void => {
  const normalizedPath = normalizeWorkspacePath(cwd);
  set(workspaceBrowseErrorAtom, null);

  if (get(workspacePickerPurposeAtom) === 'git-checkout-destination') {
    set(gitCheckoutParentPathAtom, normalizedPath);
    set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
    router.back();
    return;
  }

  set(defaultStartCwdAtom, normalizedPath);
  returnToChat(get);
});

export const openGitCheckoutAtom = atom(
  null,
  (get, set, initialParentPath?: string | null): void => {
    const { profileId, chatId } = getWorkspaceRouteIds(get);
    if (!profileId) {
      router.replace(routes.onboarding);
      return;
    }
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
    router.push(routes.gitCheckout(profileId, chatId));
    void set(refreshWorkspaceRootsAtom).then((response) => {
      const bridgeRoot = normalizeWorkspacePath(response?.bridgeRoot);
      if (bridgeRoot) {
        set(gitCheckoutParentPathAtom, (current) => current ?? bridgeRoot);
      }
    });
  },
);

export const closeGitCheckoutAtom = atom(null, (get, set): void => {
  if (get(gitCheckoutCloningAtom)) {
    return;
  }
  set(gitCheckoutErrorAtom, null);
  set(resumeGitCheckoutAfterWorkspacePickerAtom, false);
  router.back();
});

export const openGitCheckoutDestinationPickerAtom = atom(null, (get, set): void => {
  set(resumeGitCheckoutAfterWorkspacePickerAtom, true);
  set(
    openWorkspacePickerAtom,
    'git-checkout-destination',
    get(gitCheckoutParentPathAtom) ??
      normalizeWorkspacePath(get(defaultStartCwdAtom)) ??
      get(workspaceBridgeRootAtom) ??
      null,
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
    const { profileId, chatId } = getWorkspaceRouteIds(get);
    if (profileId) {
      router.dismissTo(routes.chat(profileId, chatId));
    }
  } catch (err) {
    set(gitCheckoutErrorAtom, (err as Error).message);
  } finally {
    set(gitCheckoutCloningAtom, false);
  }
});
