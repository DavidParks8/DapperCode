import * as FileSystem from 'expo-file-system/legacy';
jest.mock('expo-router', () => jest.requireActual('../../testing/expoRouterMock'));
import { router } from 'expo-router';

import type { HostBridgeApiClient } from '../../api/client';
import type { AppStore } from '../types';
import { appStateSnapshotAtom } from '../appState/atoms';
import { apiClientAtom } from '../bridge/atoms';
import { createBridgeTestStore } from '../testing';
import { defaultStartCwdAtom } from '../appState/settings';
import { routes } from '../../navigation/routes';
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
  loadingWorkspaceBrowseAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseCacheAtom,
  workspaceBrowseEntriesAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
  workspaceBrowseTruncationAtom,
  workspaceFavoritesResourceAtom,
  workspacePickerPurposeAtom,
  workspaceRootsAtom,
  workspaceRootsRefreshErrorAtom,
  workspaceRootsResourceAtom,
} from './workspace';
import {
  browseWorkspacePathAtom,
  changeGitCheckoutDirectoryNameAtom,
  changeGitCheckoutRepoUrlAtom,
  closeGitCheckoutAtom,
  closeWorkspacePickerAtom,
  loadWorkspaceFavoritesAtom,
  openGitCheckoutAtom,
  openGitCheckoutDestinationPickerAtom,
  openWorkspaceModalAtom,
  refreshWorkspaceRootsAtom,
  selectWorkspaceAtom,
  submitGitCheckoutAtom,
  toggleWorkspaceFavoriteAtom,
  WORKSPACE_RESOURCES_TTL_MS,
} from './workspaceActions';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn().mockRejectedValue(new Error('missing')),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn(),
}));

interface ApiMocks {
  listFilesystemEntries: jest.Mock;
  listWorkspaceRoots: jest.Mock;
  gitClone: jest.Mock;
}

function createStore(overrides: Partial<ApiMocks> = {}): { store: AppStore; api: ApiMocks } {
  const api: ApiMocks = {
    listFilesystemEntries: overrides.listFilesystemEntries ?? jest.fn(),
    listWorkspaceRoots: overrides.listWorkspaceRoots ?? jest.fn(),
    gitClone: overrides.gitClone ?? jest.fn(),
  };
  const store = createBridgeTestStore({ api: api as unknown as HostBridgeApiClient });
  return { store, api };
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    bridgeRoot: '/workspace',
    path: '/workspace',
    parentPath: null,
    truncated: false,
    totalEntries: 1,
    entries: [{ name: 'mobile', path: '/workspace/mobile', isDirectory: true, isGitRepo: false }],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function switchProfile(store: AppStore, profileId: string): void {
  const snapshot = store.get(appStateSnapshotAtom);
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: {
        ...snapshot.data.bridgeProfiles,
        activeProfileId: profileId,
        profiles: [
          ...snapshot.data.bridgeProfiles.profiles,
          {
            id: profileId,
            name: profileId,
            bridgeUrl: `https://${profileId}.test`,
            bridgeToken: 'token',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ].filter(
          (profile, index, profiles) => profiles.findIndex(({ id }) => id === profile.id) === index,
        ),
      },
    },
  });
}

/**
 * Edits the currently active bridge profile in place: same ID, but a new bridge URL (and,
 * realistically, a bumped `updatedAt`) — simulating a user re-pointing an existing profile at a
 * different bridge instance, or a reconnect that rotates credentials, without deleting and
 * recreating the profile.
 */
function editActiveProfile(
  store: AppStore,
  updates: { bridgeUrl?: string; bridgeToken?: string; updatedAt?: string },
): void {
  const snapshot = store.get(appStateSnapshotAtom);
  const { activeProfileId } = snapshot.data.bridgeProfiles;
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: {
        ...snapshot.data.bridgeProfiles,
        profiles: snapshot.data.bridgeProfiles.profiles.map((profile) =>
          profile.id === activeProfileId
            ? {
                ...profile,
                bridgeUrl: updates.bridgeUrl ?? profile.bridgeUrl,
                bridgeToken: updates.bridgeToken ?? profile.bridgeToken,
                updatedAt: updates.updatedAt ?? '2026-02-01T00:00:00.000Z',
              }
            : profile,
        ),
      },
    },
  });
}

describe('workspace actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(FileSystem.readAsStringAsync).mockRejectedValue(new Error('missing'));
    jest.mocked(FileSystem.writeAsStringAsync).mockResolvedValue(undefined);
  });

  it('keeps cached roots visible while stale data revalidates and survives failure', async () => {
    const { store, api } = createStore();
    api.listWorkspaceRoots
      .mockResolvedValueOnce({
        bridgeRoot: '/workspace',
        workspaces: [{ path: '/a', chatCount: 1 }],
      })
      .mockResolvedValueOnce({
        bridgeRoot: '/workspace',
        workspaces: [{ path: '/b', chatCount: 2 }],
      })
      .mockRejectedValueOnce(new Error('roots unavailable'));

    await store.set(refreshWorkspaceRootsAtom, { now: 100 });
    expect(store.get(workspaceBridgeRootAtom)).toBe('/workspace');
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/a', chatCount: 1 }]);
    expect(store.get(workspaceRootsResourceAtom)).toMatchObject({
      error: null,
      fetchedAt: 100,
      refreshing: false,
    });

    await store.set(refreshWorkspaceRootsAtom, {
      now: 100 + WORKSPACE_RESOURCES_TTL_MS - 1,
    });
    expect(api.listWorkspaceRoots).toHaveBeenCalledTimes(1);

    const refresh = store.set(refreshWorkspaceRootsAtom, {
      now: 100 + WORKSPACE_RESOURCES_TTL_MS,
    });
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/a', chatCount: 1 }]);
    expect(store.get(workspaceRootsResourceAtom).refreshing).toBe(true);
    await refresh;
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/b', chatCount: 2 }]);

    expect(await store.set(refreshWorkspaceRootsAtom, { force: true })).toBeNull();
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/b', chatCount: 2 }]);
    expect(store.get(workspaceRootsRefreshErrorAtom)).toBe('roots unavailable');
    expect(store.get(workspaceBrowseErrorAtom)).toBeNull();
  });

  it('deduplicates root requests and ignores an older client response', async () => {
    const first = deferred<{
      bridgeRoot: string;
      allowOutsideRootCwd: boolean;
      workspaces: { path: string; chatCount: number }[];
    }>();
    const second = deferred<{
      bridgeRoot: string;
      allowOutsideRootCwd: boolean;
      workspaces: { path: string; chatCount: number }[];
    }>();
    const { store, api } = createStore();
    api.listWorkspaceRoots.mockReturnValue(first.promise);

    const firstRefresh = store.set(refreshWorkspaceRootsAtom, { force: true });
    const duplicateRefresh = store.set(refreshWorkspaceRootsAtom, { force: true });
    expect(api.listWorkspaceRoots).toHaveBeenCalledTimes(1);

    const nextApi = {
      ...api,
      listWorkspaceRoots: jest.fn().mockReturnValue(second.promise),
    };
    store.set(apiClientAtom, nextApi as unknown as HostBridgeApiClient);
    const newerRefresh = store.set(refreshWorkspaceRootsAtom, { force: true });
    second.resolve({
      bridgeRoot: '/new',
      allowOutsideRootCwd: false,
      workspaces: [{ path: '/new/repo', chatCount: 2 }],
    });
    await newerRefresh;

    first.resolve({
      bridgeRoot: '/old',
      allowOutsideRootCwd: false,
      workspaces: [{ path: '/old/repo', chatCount: 1 }],
    });
    await Promise.all([firstRefresh, duplicateRefresh]);
    expect(store.get(workspaceBridgeRootAtom)).toBe('/new');
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/new/repo', chatCount: 2 }]);
  });

  it('isolates cached roots and favorites by active bridge profile', async () => {
    const { store, api } = createStore();
    jest.mocked(FileSystem.readAsStringAsync).mockImplementation(async (path) =>
      JSON.stringify({
        version: 1,
        paths: String(path).includes('profile-2') ? ['/two/favorite'] : ['/one/favorite'],
      }),
    );
    api.listWorkspaceRoots
      .mockResolvedValueOnce({
        bridgeRoot: '/one',
        workspaces: [{ path: '/one/repo', chatCount: 1 }],
      })
      .mockResolvedValueOnce({
        bridgeRoot: '/two',
        workspaces: [{ path: '/two/repo', chatCount: 2 }],
      });

    await Promise.all([
      store.set(refreshWorkspaceRootsAtom, { force: true }),
      store.set(loadWorkspaceFavoritesAtom, { force: true }),
    ]);
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/one/repo', chatCount: 1 }]);
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/one/favorite']);

    switchProfile(store, 'profile-2');
    expect(store.get(workspaceRootsAtom)).toEqual([]);
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual([]);
    await Promise.all([
      store.set(refreshWorkspaceRootsAtom, { force: true }),
      store.set(loadWorkspaceFavoritesAtom, { force: true }),
    ]);
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/two/repo', chatCount: 2 }]);
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/two/favorite']);

    switchProfile(store, 'profile-1');
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/one/repo', chatCount: 1 }]);
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/one/favorite']);
    expect(store.get(workspaceFavoritesResourceAtom).fetchedAt).not.toBeNull();
  });

  it('clears cached roots and browse data (but keeps favorites) when a profile is edited in place', async () => {
    const { store, api } = createStore();
    jest
      .mocked(FileSystem.readAsStringAsync)
      .mockResolvedValue(JSON.stringify({ version: 1, paths: ['/one/favorite'] }));
    api.listWorkspaceRoots.mockResolvedValueOnce({
      bridgeRoot: '/old-bridge',
      workspaces: [{ path: '/old-bridge/repo', chatCount: 1 }],
    });
    api.listFilesystemEntries.mockResolvedValueOnce(
      listing({
        bridgeRoot: '/old-bridge',
        path: '/old-bridge',
        entries: [{ name: 'old', path: '/old-bridge/old', isDirectory: true, isGitRepo: false }],
      }),
    );

    await store.set(refreshWorkspaceRootsAtom, { now: 100 });
    await store.set(loadWorkspaceFavoritesAtom, { now: 100 });
    await store.set(browseWorkspacePathAtom, '/old-bridge');
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/old-bridge/repo', chatCount: 1 }]);
    expect(store.get(workspaceBrowseEntriesAtom)[0]?.name).toBe('old');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/one/favorite']);

    // Same profile ID, new bridge URL: the user repointed the profile without deleting it.
    editActiveProfile(store, { bridgeUrl: 'https://new-bridge.test' });

    // The stale roots/browse cache from the previous bridge must not leak into the edited
    // profile, but locally-stored favorites are keyed by profile ID only and survive.
    expect(store.get(workspaceRootsResourceAtom)).toMatchObject({ data: [], fetchedAt: null });
    expect(store.get(workspaceRootsAtom)).toEqual([]);
    expect(store.get(workspaceBrowseCacheAtom)['/old-bridge']).toBeUndefined();
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/one/favorite']);

    api.listWorkspaceRoots.mockResolvedValueOnce({
      bridgeRoot: '/new-bridge',
      workspaces: [{ path: '/new-bridge/repo', chatCount: 5 }],
    });
    await store.set(refreshWorkspaceRootsAtom, { now: 200 });
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/new-bridge/repo', chatCount: 5 }]);

    // Browsing the same path string after the edit must hit the new bridge, not stale cache.
    api.listFilesystemEntries.mockResolvedValueOnce(
      listing({
        bridgeRoot: '/new-bridge',
        path: '/old-bridge',
        entries: [
          { name: 'fresh', path: '/old-bridge/fresh', isDirectory: true, isGitRepo: false },
        ],
      }),
    );
    await store.set(browseWorkspacePathAtom, '/old-bridge');
    expect(store.get(workspaceBrowseEntriesAtom)[0]?.name).toBe('fresh');
  });

  it('ignores a roots response for a previous identity even if a coincidental requestId matches', async () => {
    const staleFetch = deferred<{
      bridgeRoot: string;
      workspaces: { path: string; chatCount: number }[];
    }>();
    const { store, api } = createStore();
    api.listWorkspaceRoots.mockReturnValueOnce(staleFetch.promise);

    const staleRefresh = store.set(refreshWorkspaceRootsAtom, { force: true });
    expect(store.get(workspaceRootsResourceAtom).refreshing).toBe(true);

    // The profile is edited (or the bridge reconnects with a new identity) while the request from
    // the old identity is still in flight. Reading the resource immediately reflects the new,
    // empty identity rather than the previous bridge's refreshing state.
    editActiveProfile(store, { bridgeUrl: 'https://reconnected-bridge.test' });
    expect(store.get(workspaceRootsResourceAtom)).toMatchObject({
      data: [],
      fetchedAt: null,
      refreshing: false,
    });

    // A fresh refresh under the new identity starts from the same baseline requestId as the old
    // one did, so its requestId can coincidentally match the still-pending old request.
    const freshFetch = deferred<{
      bridgeRoot: string;
      workspaces: { path: string; chatCount: number }[];
    }>();
    api.listWorkspaceRoots.mockReturnValueOnce(freshFetch.promise);
    const freshRefresh = store.set(refreshWorkspaceRootsAtom, { force: true });
    expect(store.get(workspaceRootsResourceAtom).refreshing).toBe(true);

    // The stale response from the previous identity resolves after the new request has already
    // started; it must not overwrite the new identity's in-flight/committed state.
    staleFetch.resolve({
      bridgeRoot: '/old-bridge',
      workspaces: [{ path: '/old-bridge/repo', chatCount: 1 }],
    });
    await staleRefresh;
    expect(store.get(workspaceRootsResourceAtom).refreshing).toBe(true);
    expect(store.get(workspaceRootsAtom)).toEqual([]);

    freshFetch.resolve({
      bridgeRoot: '/reconnected-bridge',
      workspaces: [{ path: '/reconnected-bridge/repo', chatCount: 3 }],
    });
    await freshRefresh;
    expect(store.get(workspaceRootsAtom)).toEqual([
      { path: '/reconnected-bridge/repo', chatCount: 3 },
    ]);
    expect(store.get(workspaceBridgeRootAtom)).toBe('/reconnected-bridge');
  });

  it('drops a stale browse response left over from a previous identity, with no leaked entries', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValueOnce(
      listing({
        path: '/workspace',
        entries: [{ name: 'first', path: '/workspace/first', isDirectory: true, isGitRepo: false }],
      }),
    );
    await store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(workspaceBrowseEntriesAtom)[0]?.name).toBe('first');

    const staleListing = deferred<ReturnType<typeof listing>>();
    api.listFilesystemEntries.mockReturnValueOnce(staleListing.promise);
    const staleBrowse = store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(loadingWorkspaceBrowseAtom)).toBe(true);

    // Edit the profile in place while the revalidation for the previous identity is in flight.
    // The cache for the previous identity is invalidated immediately, even before the in-flight
    // request settles.
    editActiveProfile(store, { bridgeUrl: 'https://reconnected-bridge.test' });
    expect(store.get(workspaceBrowseCacheAtom)['/workspace']).toBeUndefined();

    staleListing.resolve(
      listing({
        path: '/workspace',
        entries: [{ name: 'stale', path: '/workspace/stale', isDirectory: true, isGitRepo: false }],
      }),
    );
    await staleBrowse;

    // The stale, previous-identity response must not repopulate the cache or overwrite the
    // currently displayed listing with data from the old bridge.
    expect(store.get(workspaceBrowseEntriesAtom)[0]?.name).toBe('first');
    expect(store.get(workspaceBrowseCacheAtom)['/workspace']).toBeUndefined();
  });

  it('does not let an older favorites load overwrite a local toggle', async () => {
    const { store } = createStore();
    const loadedFavorites = deferred<string>();
    jest.mocked(FileSystem.readAsStringAsync).mockReturnValueOnce(loadedFavorites.promise);

    const load = store.set(loadWorkspaceFavoritesAtom, { force: true });
    await Promise.resolve();
    store.set(toggleWorkspaceFavoriteAtom, '/workspace/local');
    loadedFavorites.resolve(JSON.stringify({ version: 1, paths: ['/workspace/stale'] }));
    await load;

    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/workspace/local']);
  });

  it('serves the browse cache before the network and reports truncation', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing({ truncated: true, totalEntries: 9 }));

    await store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(workspaceBrowsePathAtom)).toBe('/workspace');
    expect(store.get(workspaceBrowseParentPathAtom)).toBeNull();
    expect(store.get(workspaceBrowseEntriesAtom)).toHaveLength(1);
    expect(store.get(workspaceBrowseTruncationAtom)).toBe('Showing 1 of 9 entries.');
    expect(store.get(loadingWorkspaceBrowseAtom)).toBe(false);

    api.listFilesystemEntries.mockResolvedValue(listing({ truncated: false }));
    await store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(workspaceBrowseTruncationAtom)).toBeNull();
  });

  it('keeps cached browse entries visible during revalidation and ignores older navigation', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValueOnce(
      listing({
        entries: [
          { name: 'cached', path: '/workspace/cached', isDirectory: true, isGitRepo: false },
        ],
      }),
    );
    await store.set(browseWorkspacePathAtom, '/workspace');

    const refreshed = deferred<ReturnType<typeof listing>>();
    api.listFilesystemEntries.mockReturnValueOnce(refreshed.promise);
    const refresh = store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(workspaceBrowseEntriesAtom)[0]?.name).toBe('cached');
    expect(store.get(loadingWorkspaceBrowseAtom)).toBe(true);

    const navigated = deferred<ReturnType<typeof listing>>();
    api.listFilesystemEntries.mockReturnValueOnce(navigated.promise);
    const navigate = store.set(browseWorkspacePathAtom, '/workspace/next');
    navigated.resolve(
      listing({
        path: '/workspace/next',
        entries: [
          { name: 'new', path: '/workspace/next/new', isDirectory: true, isGitRepo: false },
        ],
      }),
    );
    await navigate;
    refreshed.resolve(
      listing({
        entries: [{ name: 'stale', path: '/workspace/stale', isDirectory: true, isGitRepo: false }],
      }),
    );
    await refresh;
    expect(store.get(workspaceBrowsePathAtom)).toBe('/workspace/next');
    expect(store.get(workspaceBrowseEntriesAtom)[0]?.name).toBe('new');
  });

  it('never persists directory listings', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing());

    await store.set(browseWorkspacePathAtom, '/workspace');

    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('falls back to the start folder when the saved workspace is gone', async () => {
    const { store, api } = createStore();
    store.set(defaultStartCwdAtom, '/workspace/missing');
    api.listFilesystemEntries
      .mockRejectedValueOnce(new Error('workspace directory is invalid or inaccessible'))
      .mockResolvedValueOnce(listing({ path: '/workspace' }));

    await store.set(browseWorkspacePathAtom, '/workspace/missing');
    expect(store.get(workspaceBrowseErrorAtom)).toBe(
      'Saved workspace was not found. Showing start folder.',
    );
    expect(store.get(defaultStartCwdAtom)).toBeNull();
  });

  it('surfaces the original error when the fallback listing also fails', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries
      .mockRejectedValueOnce(new Error('workspace directory must point to a folder'))
      .mockRejectedValueOnce(new Error('root denied'));

    await store.set(browseWorkspacePathAtom, '/workspace/missing');
    expect(store.get(workspaceBrowseErrorAtom)).toBe('workspace directory must point to a folder');
  });

  it('reports an unrecoverable browse failure', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockRejectedValue(new Error('browse denied'));

    await store.set(browseWorkspacePathAtom, null);
    expect(store.get(workspaceBrowseErrorAtom)).toBe('browse denied');
  });

  it('routes the picker back to where it was opened from', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing());
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/workspace', workspaces: [] });
    store.set(openWorkspaceModalAtom);
    expect(router.push).toHaveBeenCalledWith(routes.workspacePicker('profile-1', 'new'));
    expect(store.get(workspacePickerPurposeAtom)).toBe('default-start');

    store.set(closeWorkspacePickerAtom);
    expect(router.dismissTo).toHaveBeenCalledWith(routes.newChat('profile-1'));
  });

  it('returns to git checkout after choosing a destination', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing());
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/workspace', workspaces: [] });

    store.set(openGitCheckoutAtom, '/workspace');
    expect(router.push).toHaveBeenCalledWith(routes.gitCheckout('profile-1', 'new'));
    expect(store.get(gitCheckoutParentPathAtom)).toBe('/workspace');

    store.set(openGitCheckoutDestinationPickerAtom);
    expect(router.push).toHaveBeenCalledWith(routes.workspacePicker('profile-1', 'new'));
    expect(store.get(resumeGitCheckoutAfterWorkspacePickerAtom)).toBe(true);

    // Backing out of the picker resumes the checkout it interrupted.
    store.set(closeWorkspacePickerAtom);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(store.get(resumeGitCheckoutAfterWorkspacePickerAtom)).toBe(false);

    store.set(openGitCheckoutDestinationPickerAtom);
    store.set(selectWorkspaceAtom, '/workspace/destination');
    expect(router.back).toHaveBeenCalledTimes(2);
    expect(store.get(gitCheckoutParentPathAtom)).toBe('/workspace/destination');
  });

  it('records the chosen default workspace and leaves the picker', () => {
    const { store } = createStore();
    store.set(workspacePickerPurposeAtom, 'default-start');

    store.set(selectWorkspaceAtom, '/workspace/app');
    expect(store.get(defaultStartCwdAtom)).toBe('/workspace/app');
    expect(router.dismissTo).toHaveBeenCalledWith(routes.newChat('profile-1'));
  });

  it('keeps the checkout open while a clone is running', () => {
    const { store } = createStore();
    store.set(gitCheckoutCloningAtom, true);

    store.set(closeGitCheckoutAtom);
    expect(router.dismissTo).not.toHaveBeenCalled();

    store.set(gitCheckoutCloningAtom, false);
    store.set(closeGitCheckoutAtom);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('returns from checkout to the workspace picker that opened it', () => {
    const { store, api } = createStore();
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/workspace', workspaces: [] });
    api.listFilesystemEntries.mockResolvedValue(listing());

    store.set(openWorkspaceModalAtom);
    store.set(openGitCheckoutAtom, '/workspace');
    store.set(closeGitCheckoutAtom);

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('derives the directory name until the field is edited', () => {
    const { store } = createStore();

    store.set(changeGitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
    expect(store.get(gitCheckoutDirectoryNameAtom)).toBe('repo');

    store.set(changeGitCheckoutDirectoryNameAtom, 'custom');
    expect(store.get(gitCheckoutDirectoryNameEditedAtom)).toBe(true);

    store.set(changeGitCheckoutRepoUrlAtom, 'git@github.com:org/other.git');
    expect(store.get(gitCheckoutDirectoryNameAtom)).toBe('custom');

    // Clearing the field hands control back to the derived name.
    store.set(changeGitCheckoutDirectoryNameAtom, '  ');
    store.set(changeGitCheckoutRepoUrlAtom, 'git@github.com:org/third.git');
    expect(store.get(gitCheckoutDirectoryNameAtom)).toBe('third');
  });

  it('validates the clone form before calling the bridge', async () => {
    const { store, api } = createStore();
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: null, workspaces: [] });

    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('Paste an HTTPS or SSH repository URL first.');

    store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('Choose a valid folder name for the cloned repo.');

    store.set(gitCheckoutDirectoryNameAtom, 'repo');
    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('Choose where the repository should be cloned.');
    expect(api.gitClone).not.toHaveBeenCalled();
  });

  it('reports clone failures and adopts the workspace on success', async () => {
    const { store, api } = createStore();
    store.set(gitCheckoutRepoUrlAtom, ' git@github.com:org/repo.git ');
    store.set(gitCheckoutDirectoryNameAtom, 'repo');
    store.set(gitCheckoutParentPathAtom, '/workspace');
    api.gitClone
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'permission denied', cloned: false })
      .mockRejectedValueOnce(new Error('clone transport failed'))
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', cloned: true, cwd: null });

    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toContain('permission denied');
    expect(router.dismissTo).not.toHaveBeenCalled();

    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('clone transport failed');

    await store.set(submitGitCheckoutAtom);
    expect(api.gitClone).toHaveBeenLastCalledWith({
      url: 'git@github.com:org/repo.git',
      parentPath: '/workspace',
      directoryName: 'repo',
    });
    expect(store.get(defaultStartCwdAtom)).toBe('/workspace/repo');
    expect(store.get(workspaceBrowsePathAtom)).toBe('/workspace/repo');
    expect(store.get(workspaceBrowseParentPathAtom)).toBe('/workspace');
    expect(router.dismissTo).toHaveBeenCalledWith(routes.newChat('profile-1'));
    expect(store.get(gitCheckoutCloningAtom)).toBe(false);
  });

  it('resolves the parent path from the bridge root when none was chosen', async () => {
    const { store, api } = createStore();
    store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
    store.set(gitCheckoutDirectoryNameAtom, 'repo');
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/bridge-root', workspaces: [] });
    api.gitClone.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      cloned: true,
      cwd: '/bridge-root/repo',
    });

    await store.set(submitGitCheckoutAtom);
    expect(api.gitClone).toHaveBeenCalledWith({
      url: 'git@github.com:org/repo.git',
      parentPath: '/bridge-root',
      directoryName: 'repo',
    });
    expect(store.get(defaultStartCwdAtom)).toBe('/bridge-root/repo');
  });

  it('toggles favorites and ignores blank paths', () => {
    const { store } = createStore();

    store.set(toggleWorkspaceFavoriteAtom, '   ');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual([]);

    store.set(toggleWorkspaceFavoriteAtom, '/workspace/a');
    store.set(toggleWorkspaceFavoriteAtom, '/workspace/b');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/workspace/b', '/workspace/a']);

    store.set(toggleWorkspaceFavoriteAtom, '/workspace/b');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/workspace/a']);
  });
});
