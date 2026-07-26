import { atom } from 'jotai';

import { HostBridgeApiClient } from '../../api/client';
import { HostBridgeWsClient } from '../../api/ws';
import { getActiveBridgeProfile } from '../../bridgeProfiles';
import { env } from '../../config';
import { bridgeProfileStoreAtom } from '../appState/atoms';

export const activeBridgeProfileAtom = atom((get) =>
  getActiveBridgeProfile(get(bridgeProfileStoreAtom))
);

export const bridgeUrlAtom = atom((get) => get(activeBridgeProfileAtom)?.bridgeUrl ?? null);

export const bridgeTokenAtom = atom((get) => get(activeBridgeProfileAtom)?.bridgeToken ?? null);

export const wsClientAtom = atom((get) => {
  const bridgeUrl = get(bridgeUrlAtom);
  if (!bridgeUrl) {
    return null;
  }
  return new HostBridgeWsClient(bridgeUrl, {
    authToken: get(bridgeTokenAtom) ?? env.hostBridgeToken,
    allowQueryTokenAuth: env.allowWsQueryTokenAuth,
  });
});

export const apiClientAtom = atom((get) => {
  const ws = get(wsClientAtom);
  const bridgeUrl = get(bridgeUrlAtom);
  if (!ws) {
    return null;
  }
  return new HostBridgeApiClient({
    ws,
    bridgeUrl: bridgeUrl ?? undefined,
    authToken: get(bridgeTokenAtom) ?? env.hostBridgeToken,
  });
});

/** Connection status published by the active WebSocket client. */
export const bridgeConnectedAtom = atom(false);
