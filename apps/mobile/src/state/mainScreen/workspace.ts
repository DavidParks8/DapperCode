import type { Getter } from 'jotai';
import type { SetStateAction } from 'react';

import type { HostBridgeApiClient } from '../../api/client';
import type {
  ChatSummary,
  FileSystemEntry,
  FileSystemListResponse,
  WorkspaceSummary,
} from '../../api/types';
import type { WorkspacePickerPurpose } from '../../screens/main/mainScreenHelpers';
import { activeBridgeProfileAtom, apiClientAtom } from '../bridge/atoms';
import { derivedScreenAtom, screenAtom } from './registry';

export const relatedAgentThreadsAtom = screenAtom<ChatSummary[]>(() => []);

export const agentRootThreadIdAtom = screenAtom<string | null>(null);

export const agentRuntimeRevisionAtom = screenAtom(0);

export const loadingAgentThreadsAtom = screenAtom(false);

export const workspacePickerPurposeAtom = screenAtom<WorkspacePickerPurpose>('default-start');

export interface WorkspaceRootsResource {
  bridgeRoot: string | null;
  data: WorkspaceSummary[];
  error: string | null;
  fetchedAt: number | null;
  refreshing: boolean;
  requestId: number;
}

export interface WorkspaceFavoritesResource {
  data: string[];
  error: string | null;
  fetchedAt: number | null;
  refreshing: boolean;
  requestId: number;
}

const EMPTY_WORKSPACE_ROOTS: WorkspaceRootsResource = {
  bridgeRoot: null,
  data: [],
  error: null,
  fetchedAt: null,
  refreshing: false,
  requestId: 0,
};

const EMPTY_WORKSPACE_FAVORITES: WorkspaceFavoritesResource = {
  data: [],
  error: null,
  fetchedAt: null,
  refreshing: false,
  requestId: 0,
};

/**
 * Roots and browse cache entries additionally carry the bridge/client identity that produced
 * them. A profile can be edited in place (same ID, new bridge URL or token), which bumps
 * `updatedAt`; keying cached entries only by profile ID would let data fetched from the previous
 * bridge leak into the edited profile until the next successful fetch overwrote it. Favorites are
 * local to the device, so they stay keyed by profile ID alone.
 */
interface WorkspaceRootsCacheEntry extends WorkspaceRootsResource {
  identityKey: string;
}

export const workspaceRootsByProfileAtom = screenAtom<
  Record<string, WorkspaceRootsCacheEntry | undefined>
>(() => ({}));

export const workspaceFavoritesByProfileAtom = screenAtom<
  Record<string, WorkspaceFavoritesResource | undefined>
>(() => ({}));

function activeProfileId(get: Getter): string | null {
  return get(activeBridgeProfileAtom)?.id ?? null;
}

export interface WorkspaceBridgeIdentity {
  profileId: string;
  identityKey: string;
  client: HostBridgeApiClient;
}

/**
 * The bridge/client identity behind the active profile, used to key roots and directory-browse
 * caches. `identityKey` changes whenever the profile is edited (its `updatedAt` or `bridgeUrl`
 * changes), so cached data scoped to a previous identity is never surfaced as fresh. `client` lets
 * callers additionally dedupe in-flight requests per API client instance.
 */
export const activeWorkspaceIdentityAtom = derivedScreenAtom(
  (get): WorkspaceBridgeIdentity | null => {
    const profile = get(activeBridgeProfileAtom);
    const client = get(apiClientAtom);
    return profile && client
      ? {
          profileId: profile.id,
          identityKey: `${profile.id}\u0000${profile.updatedAt}\u0000${profile.bridgeUrl}`,
          client,
        }
      : null;
  },
);

export const workspaceRootsResourceAtom = derivedScreenAtom((get): WorkspaceRootsResource => {
  const identity = get(activeWorkspaceIdentityAtom);
  if (!identity) return EMPTY_WORKSPACE_ROOTS;
  const cached = get(workspaceRootsByProfileAtom)[identity.profileId];
  return cached?.identityKey === identity.identityKey ? cached : EMPTY_WORKSPACE_ROOTS;
});

export const workspaceFavoritesResourceAtom = derivedScreenAtom((get) => {
  const profileId = activeProfileId(get);
  return (
    (profileId && get(workspaceFavoritesByProfileAtom)[profileId]) || EMPTY_WORKSPACE_FAVORITES
  );
});

export const workspaceRootsAtom = derivedScreenAtom(
  (get) => get(workspaceRootsResourceAtom).data,
  (get, set, update: SetStateAction<WorkspaceSummary[]>): void => {
    const identity = get(activeWorkspaceIdentityAtom);
    if (!identity) return;
    const current = get(workspaceRootsResourceAtom);
    const data = typeof update === 'function' ? update(current.data) : update;
    set(workspaceRootsByProfileAtom, (resources) => ({
      ...resources,
      [identity.profileId]: { ...current, identityKey: identity.identityKey, data },
    }));
  },
);

export const workspaceBridgeRootAtom = derivedScreenAtom(
  (get) => get(workspaceRootsResourceAtom).bridgeRoot,
  (get, set, update: SetStateAction<string | null>): void => {
    const identity = get(activeWorkspaceIdentityAtom);
    if (!identity) return;
    const current = get(workspaceRootsResourceAtom);
    const bridgeRoot = typeof update === 'function' ? update(current.bridgeRoot) : update;
    set(workspaceRootsByProfileAtom, (resources) => ({
      ...resources,
      [identity.profileId]: { ...current, identityKey: identity.identityKey, bridgeRoot },
    }));
  },
);

export const workspaceRootsRefreshingAtom = derivedScreenAtom(
  (get) => get(workspaceRootsResourceAtom).refreshing,
);

export const workspaceRootsRefreshErrorAtom = derivedScreenAtom(
  (get) => get(workspaceRootsResourceAtom).error,
);

export const workspaceBrowsePathAtom = screenAtom<string | null>(null);

export const workspaceBrowseParentPathAtom = screenAtom<string | null>(null);

export const workspaceBrowseEntriesAtom = screenAtom<FileSystemEntry[]>(() => []);

export const loadingWorkspaceBrowseAtom = screenAtom(false);

export const workspaceBrowseErrorAtom = screenAtom<string | null>(null);

export const workspaceBrowseTruncationAtom = screenAtom<string | null>(null);

export const favoriteWorkspacePathsAtom = derivedScreenAtom(
  (get) => get(workspaceFavoritesResourceAtom).data,
  (get, set, update: SetStateAction<string[]>): void => {
    const profileId = activeProfileId(get);
    if (!profileId) return;
    const current = get(workspaceFavoritesResourceAtom);
    const data = typeof update === 'function' ? update(current.data) : update;
    set(workspaceFavoritesByProfileAtom, (resources) => ({
      ...resources,
      [profileId]: { ...current, data },
    }));
  },
);

export const workspaceFavoritesRefreshErrorAtom = derivedScreenAtom(
  (get) => get(workspaceFavoritesResourceAtom).error,
);

interface WorkspaceBrowseCacheEntry {
  identityKey: string;
  entries: Record<string, FileSystemListResponse>;
}

const workspaceBrowseCacheByProfileAtom = screenAtom<
  Record<string, WorkspaceBrowseCacheEntry | undefined>
>(() => ({}));

export const workspaceBrowseCacheAtom = derivedScreenAtom(
  (get) => {
    const identity = get(activeWorkspaceIdentityAtom);
    if (!identity) return {};
    const cached = get(workspaceBrowseCacheByProfileAtom)[identity.profileId];
    return cached?.identityKey === identity.identityKey ? cached.entries : {};
  },
  (get, set, update: SetStateAction<Record<string, FileSystemListResponse>>): void => {
    const identity = get(activeWorkspaceIdentityAtom);
    if (!identity) return;
    const current = get(workspaceBrowseCacheAtom);
    const entries = typeof update === 'function' ? update(current) : update;
    set(workspaceBrowseCacheByProfileAtom, (resources) => ({
      ...resources,
      [identity.profileId]: { identityKey: identity.identityKey, entries },
    }));
  },
);

export const workspaceBrowseRequestIdAtom = screenAtom(0);

/**
 * Tracks the identity that the currently displayed browse state (path/entries/etc.) belongs to.
 * Compared against `identityKey` rather than profile ID so an in-place profile edit — same ID, new
 * bridge — is treated as a fresh bridge and clears the previously displayed listing instead of
 * leaving stale entries on screen while the new fetch is in flight.
 */
export const workspaceBrowseDisplayIdentityKeyAtom = screenAtom<string | null>(null);
