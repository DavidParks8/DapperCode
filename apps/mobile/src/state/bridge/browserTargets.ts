import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';

import type { HostBridgeApiClient } from '../../api/client';
import type {
  BrowserPreviewDiscoveryResponse,
  BrowserPreviewTargetSuggestion,
} from '../../api/types';
import { activeBridgeProfileAtom, apiClientAtom, wsClientAtom } from './atoms';
import { bindBrowserTargetRevalidation } from './browserTargetsLifecycle';

export const BROWSER_TARGETS_TTL_MS = 15_000;

export interface BrowserTargetsResource {
  value: BrowserPreviewTargetSuggestion[] | null;
  fetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
}

interface BrowserTargetsCacheEntry extends BrowserTargetsResource {
  identityKey: string;
}

type BrowserTargetsCache = Record<string, BrowserTargetsCacheEntry | undefined>;

interface RevalidateBrowserTargetsOptions {
  force?: boolean;
  ttlMs?: number;
}

const EMPTY_RESOURCE: BrowserTargetsResource = {
  value: null,
  fetchedAt: null,
  refreshing: false,
  error: null,
};

const browserTargetsCacheAtom = atom<BrowserTargetsCache>({});
const requestsByClient = new WeakMap<
  HostBridgeApiClient,
  Map<string, Promise<BrowserPreviewDiscoveryResponse>>
>();

const activeBrowserTargetsIdentityAtom = atom((get) => {
  const profile = get(activeBridgeProfileAtom);
  const client = get(apiClientAtom);
  return profile && client
    ? {
        profileId: profile.id,
        identityKey: `${profile.id}\u0000${profile.updatedAt}\u0000${profile.bridgeUrl}`,
        client,
      }
    : null;
});

export const activeBrowserTargetsResourceAtom = atom<BrowserTargetsResource>((get) => {
  const identity = get(activeBrowserTargetsIdentityAtom);
  if (!identity) {
    return EMPTY_RESOURCE;
  }
  const cached = get(browserTargetsCacheAtom)[identity.profileId];
  if (cached?.identityKey !== identity.identityKey) {
    return EMPTY_RESOURCE;
  }
  return {
    value: cached.value,
    fetchedAt: cached.fetchedAt,
    refreshing: cached.refreshing,
    error: cached.error,
  };
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not discover browser preview targets.';
}

function sharedRequest(
  client: HostBridgeApiClient,
  profileId: string,
): Promise<BrowserPreviewDiscoveryResponse> {
  let requests = requestsByClient.get(client);
  if (!requests) {
    requests = new Map();
    requestsByClient.set(client, requests);
  }
  const existing = requests.get(profileId);
  if (existing) {
    return existing;
  }
  const request = client.discoverBrowserPreviewTargets().finally(() => {
    if (requests?.get(profileId) === request) {
      requests.delete(profileId);
    }
  });
  requests.set(profileId, request);
  return request;
}

function isBrowserTargetsCacheFresh(
  current: BrowserTargetsCacheEntry | undefined,
  force: boolean | undefined,
  ttlMs: number,
  now: number,
): boolean {
  return (
    !force &&
    current?.value !== null &&
    current?.value !== undefined &&
    current.fetchedAt !== null &&
    now - current.fetchedAt < ttlMs
  );
}

function markBrowserTargetsRefreshing(
  cache: BrowserTargetsCache,
  profileId: string,
  identityKey: string,
  current: BrowserTargetsCacheEntry | undefined,
): BrowserTargetsCache {
  return {
    ...cache,
    [profileId]: {
      identityKey,
      value: current?.value ?? null,
      fetchedAt: current?.fetchedAt ?? null,
      refreshing: true,
      error: null,
    },
  };
}

function applyBrowserTargetsSuccess(
  cache: BrowserTargetsCache,
  profileId: string,
  identityKey: string,
  value: BrowserPreviewTargetSuggestion[],
): BrowserTargetsCache {
  const latest = cache[profileId];
  if (latest?.identityKey !== identityKey) {
    return cache;
  }
  return {
    ...cache,
    [profileId]: {
      identityKey,
      value,
      fetchedAt: Date.now(),
      refreshing: false,
      error: null,
    },
  };
}

function applyBrowserTargetsError(
  cache: BrowserTargetsCache,
  profileId: string,
  identityKey: string,
  error: unknown,
): BrowserTargetsCache {
  const latest = cache[profileId];
  if (latest?.identityKey !== identityKey) {
    return cache;
  }
  return {
    ...cache,
    [profileId]: {
      ...latest,
      refreshing: false,
      error: errorMessage(error),
    },
  };
}

export const revalidateBrowserTargetsAtom = atom(
  null,
  async (
    get,
    set,
    options: RevalidateBrowserTargetsOptions = {},
  ): Promise<BrowserPreviewTargetSuggestion[] | null> => {
    const identity = get(activeBrowserTargetsIdentityAtom);
    if (!identity) {
      return null;
    }

    const { profileId, identityKey, client } = identity;
    const now = Date.now();
    const cached = get(browserTargetsCacheAtom)[profileId];
    const current = cached?.identityKey === identityKey ? cached : undefined;
    const ttlMs = Math.max(0, options.ttlMs ?? BROWSER_TARGETS_TTL_MS);
    if (isBrowserTargetsCacheFresh(current, options.force, ttlMs, now)) {
      return current?.value ?? null;
    }

    set(browserTargetsCacheAtom, (cache) =>
      markBrowserTargetsRefreshing(cache, profileId, identityKey, current),
    );

    try {
      const response = await sharedRequest(client, profileId);
      const value = response.suggestions;
      set(browserTargetsCacheAtom, (cache) =>
        applyBrowserTargetsSuccess(cache, profileId, identityKey, value),
      );
      return value;
    } catch (error) {
      set(browserTargetsCacheAtom, (cache) =>
        applyBrowserTargetsError(cache, profileId, identityKey, error),
      );
      return current?.value ?? null;
    }
  },
);

export const refreshBrowserTargetsAtom = atom(
  null,
  (_get, set): Promise<BrowserPreviewTargetSuggestion[] | null> =>
    set(revalidateBrowserTargetsAtom, { force: true }),
);

export function useBrowserTargetsResource(): BrowserTargetsResource & {
  revalidate: () => Promise<BrowserPreviewTargetSuggestion[] | null>;
  refresh: () => Promise<BrowserPreviewTargetSuggestion[] | null>;
} {
  const identity = useAtomValue(activeBrowserTargetsIdentityAtom);
  const ws = useAtomValue(wsClientAtom);
  const resource = useAtomValue(activeBrowserTargetsResourceAtom);
  const revalidateAction = useSetAtom(revalidateBrowserTargetsAtom);
  const refreshAction = useSetAtom(refreshBrowserTargetsAtom);
  const previousIdentityRef = useRef<typeof identity>(null);
  const revalidate = useCallback(() => revalidateAction(), [revalidateAction]);
  const refresh = useCallback(() => refreshAction(), [refreshAction]);

  useEffect(() => {
    if (!identity) {
      previousIdentityRef.current = null;
      return;
    }
    const previous = previousIdentityRef.current;
    const clientReplaced =
      previous?.identityKey === identity.identityKey && previous.client !== identity.client;
    void revalidateAction({ force: clientReplaced });
    previousIdentityRef.current = identity;
    return bindBrowserTargetRevalidation(ws, () => {
      void revalidateAction();
    });
  }, [identity, revalidateAction, ws]);

  return { ...resource, revalidate, refresh };
}
