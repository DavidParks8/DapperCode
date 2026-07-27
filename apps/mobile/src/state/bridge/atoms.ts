import { atom } from 'jotai';
import { Platform } from 'react-native';

import { HostBridgeApiClient } from '../../api/client';
import { HostBridgeWsClient } from '../../api/ws';
import { getActiveBridgeProfile, getActiveUsableBridgeProfile } from '../../bridgeProfiles';
import { env } from '../../config';
import { bridgeProfileStoreAtom } from '../appState/atoms';

export const activeBridgeProfileAtom = atom((get) =>
  getActiveBridgeProfile(get(bridgeProfileStoreAtom)),
);

export const usableBridgeProfileAtom = atom((get) =>
  getActiveUsableBridgeProfile(
    get(bridgeProfileStoreAtom),
    Platform.OS === 'web' ? 'web' : 'native',
    env.hostBridgeToken,
    env.legacyHostBridgeUrl,
  ),
);

export const bridgeUrlAtom = atom((get) => get(usableBridgeProfileAtom)?.bridgeUrl ?? null);

export const bridgeTokenAtom = atom((get) => {
  const profile = get(usableBridgeProfileAtom);
  return profile ? (profile.bridgeToken ?? env.hostBridgeToken) : null;
});

const wsClientOverrideAtom = atom<HostBridgeWsClient | null>(null);
const apiClientOverrideAtom = atom<HostBridgeApiClient | null>(null);

/**
 * The clients are derived from the active bridge profile. Writing to these atoms installs an
 * override, which is the injection seam used by tests.
 */
export const wsClientAtom = atom(
  (get) => {
    const override = get(wsClientOverrideAtom);
    if (override) {
      return override;
    }
    const bridgeUrl = get(bridgeUrlAtom);
    if (!bridgeUrl) {
      return null;
    }
    return new HostBridgeWsClient(bridgeUrl, {
      authToken: get(bridgeTokenAtom),
      allowQueryTokenAuth: env.allowWsQueryTokenAuth,
    });
  },
  (get, set, client: HostBridgeWsClient | null) => {
    set(wsClientOverrideAtom, client);
  },
);

export const apiClientAtom = atom(
  (get) => {
    const override = get(apiClientOverrideAtom);
    if (override) {
      return override;
    }
    const ws = get(wsClientAtom);
    const bridgeUrl = get(bridgeUrlAtom);
    if (!ws) {
      return null;
    }
    return new HostBridgeApiClient({
      ws,
      bridgeUrl: bridgeUrl ?? undefined,
      authToken: get(bridgeTokenAtom),
    });
  },
  (get, set, client: HostBridgeApiClient | null) => {
    set(apiClientOverrideAtom, client);
  },
);

/** Connection status published by the active WebSocket client. */
export const bridgeConnectedAtom = atom(false);
