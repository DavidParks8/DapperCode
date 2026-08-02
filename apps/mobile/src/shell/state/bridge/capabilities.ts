import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { BridgeCapabilities } from '@bridge/types/types';
import { activeBridgeProfileAtom, apiClientAtom } from '@shell/state/bridge/atoms';

export const BRIDGE_CAPABILITIES_TTL_MS = 60_000;

export interface BridgeCapabilitiesResource {
  value: BridgeCapabilities | null;
  fetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
}

interface BridgeCapabilitiesCacheEntry extends BridgeCapabilitiesResource {
  identityKey: string;
}

type BridgeCapabilitiesCache = Record<string, BridgeCapabilitiesCacheEntry | undefined>;

interface RevalidateBridgeCapabilitiesOptions {
  force?: boolean;
  ttlMs?: number;
}

const EMPTY_RESOURCE: BridgeCapabilitiesResource = {
  value: null,
  fetchedAt: null,
  refreshing: false,
  error: null,
};

const bridgeCapabilitiesCacheAtom = atom<BridgeCapabilitiesCache>({});
const requestsByClient = new WeakMap<
  HostBridgeApiClient,
  Map<string, Promise<BridgeCapabilities>>
>();

const activeBridgeCapabilitiesIdentityAtom = atom((get) => {
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

export const activeBridgeCapabilitiesResourceAtom = atom<BridgeCapabilitiesResource>((get) => {
  const identity = get(activeBridgeCapabilitiesIdentityAtom);
  if (!identity) {
    return EMPTY_RESOURCE;
  }
  const cached = get(bridgeCapabilitiesCacheAtom)[identity.profileId];
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
  return error instanceof Error ? error.message : 'Could not read bridge capabilities.';
}

function sharedRequest(
  client: HostBridgeApiClient,
  profileId: string,
): Promise<BridgeCapabilities> {
  let requests = requestsByClient.get(client);
  if (!requests) {
    requests = new Map();
    requestsByClient.set(client, requests);
  }
  const existing = requests.get(profileId);
  if (existing) {
    return existing;
  }
  const request = client.readBridgeCapabilities().finally(() => {
    if (requests?.get(profileId) === request) {
      requests.delete(profileId);
    }
  });
  requests.set(profileId, request);
  return request;
}

export const revalidateBridgeCapabilitiesAtom = atom(
  null,
  async (
    get,
    set,
    options: RevalidateBridgeCapabilitiesOptions = {},
  ): Promise<BridgeCapabilities | null> => {
    const identity = get(activeBridgeCapabilitiesIdentityAtom);
    if (!identity) {
      return null;
    }

    const { profileId, identityKey, client } = identity;
    const now = Date.now();
    const cached = get(bridgeCapabilitiesCacheAtom)[profileId];
    const current = cached?.identityKey === identityKey ? cached : undefined;
    const ttlMs = Math.max(0, options.ttlMs ?? BRIDGE_CAPABILITIES_TTL_MS);
    if (
      !options.force &&
      current?.value &&
      current.fetchedAt !== null &&
      now - current.fetchedAt < ttlMs
    ) {
      return current.value;
    }

    set(bridgeCapabilitiesCacheAtom, (cache) => ({
      ...cache,
      [profileId]: {
        identityKey,
        value: current?.value ?? null,
        fetchedAt: current?.fetchedAt ?? null,
        refreshing: true,
        error: null,
      },
    }));

    try {
      const value = await sharedRequest(client, profileId);
      set(bridgeCapabilitiesCacheAtom, (cache) => {
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
      });
      return value;
    } catch (error) {
      set(bridgeCapabilitiesCacheAtom, (cache) => {
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
      });
      return current?.value ?? null;
    }
  },
);

export const refreshBridgeCapabilitiesAtom = atom(
  null,
  (_get, set): Promise<BridgeCapabilities | null> =>
    set(revalidateBridgeCapabilitiesAtom, { force: true }),
);

export const installBridgeCapabilitiesAtom = atom(
  null,
  (get, set, value: BridgeCapabilities | null): void => {
    const identity = get(activeBridgeCapabilitiesIdentityAtom);
    if (!identity) {
      return;
    }
    set(bridgeCapabilitiesCacheAtom, (cache) => ({
      ...cache,
      [identity.profileId]: {
        identityKey: identity.identityKey,
        value,
        fetchedAt: value ? Date.now() : null,
        refreshing: false,
        error: null,
      },
    }));
  },
);

export const bridgeCapabilitiesAtom = atom(
  (get) => get(activeBridgeCapabilitiesResourceAtom).value,
  (_get, set, value: BridgeCapabilities | null) => {
    set(installBridgeCapabilitiesAtom, value);
  },
);

export function useBridgeCapabilitiesResource(): BridgeCapabilitiesResource & {
  revalidate: () => Promise<BridgeCapabilities | null>;
  refresh: () => Promise<BridgeCapabilities | null>;
} {
  const identity = useAtomValue(activeBridgeCapabilitiesIdentityAtom);
  const resource = useAtomValue(activeBridgeCapabilitiesResourceAtom);
  const revalidateAction = useSetAtom(revalidateBridgeCapabilitiesAtom);
  const refreshAction = useSetAtom(refreshBridgeCapabilitiesAtom);
  const previousIdentityRef = useRef<typeof identity>(null);
  const revalidate = useCallback(() => revalidateAction(), [revalidateAction]);
  const refresh = useCallback(() => refreshAction(), [refreshAction]);

  useEffect(() => {
    if (identity) {
      const previous = previousIdentityRef.current;
      const clientReplaced =
        previous?.identityKey === identity.identityKey && previous.client !== identity.client;
      void revalidateAction({ force: clientReplaced });
    }
    previousIdentityRef.current = identity;
  }, [identity, revalidateAction]);

  return { ...resource, revalidate, refresh };
}
