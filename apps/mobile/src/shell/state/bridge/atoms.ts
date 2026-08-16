import { atom } from 'jotai';
import { AppState, Platform } from 'react-native';

import { HostBridgeApiClient } from '@bridge/client/client';
import { MOBILE_BRIDGE_CLIENT_NAME, MOBILE_BRIDGE_CLIENT_TYPE } from '@bridge/ws/types';
import { HostBridgeWsClient } from '@bridge/ws/ws';
import { isUserPresentAppState, supportsNativePushPresence } from '@shell/session/appVisibility';
import { getActiveBridgeProfile } from '@shell/state/bridgeProfiles';
import { env } from '@shared/config';
import { bridgeProfileStoreAtom } from '@shell/state/appState/atoms';

export const activeBridgeProfileAtom = atom((get) =>
  getActiveBridgeProfile(get(bridgeProfileStoreAtom)),
);

export const bridgeUrlAtom = atom((get) => get(activeBridgeProfileAtom)?.bridgeUrl ?? null);

export const bridgeTokenAtom = atom((get) => get(activeBridgeProfileAtom)?.bridgeToken ?? null);
export const bridgeWorkspaceIdAtom = atom(
  (get) => get(activeBridgeProfileAtom)?.workspaceId ?? null,
);

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
    const supportsPushPresence = supportsNativePushPresence(Platform.OS);
    return new HostBridgeWsClient(bridgeUrl, {
      authToken: get(bridgeTokenAtom) ?? env.hostBridgeToken,
      workspaceId: get(bridgeWorkspaceIdAtom),
      clientType: supportsPushPresence ? MOBILE_BRIDGE_CLIENT_TYPE : Platform.OS,
      clientName: MOBILE_BRIDGE_CLIENT_NAME,
      getClientForeground: supportsPushPresence
        ? () => isUserPresentAppState(AppState.currentState)
        : undefined,
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
      authToken: get(bridgeTokenAtom) ?? env.hostBridgeToken,
      profileId: get(activeBridgeProfileAtom)?.id ?? null,
    });
  },
  (get, set, client: HostBridgeApiClient | null) => {
    set(apiClientOverrideAtom, client);
  },
);

/** Connection status published by the active WebSocket client. */
export const bridgeConnectedAtom = atom(false);

/** True while the active profile, clients, and profile-scoped caches are changing together. */
export const bridgeProfileTransitioningAtom = atom(false);
