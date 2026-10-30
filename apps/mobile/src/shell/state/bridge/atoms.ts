import { atom } from 'jotai';
import { AppState, Platform } from 'react-native';

import { HostBridgeApiClient } from '@bridge/client/client';
import { MOBILE_BRIDGE_CLIENT_NAME, MOBILE_BRIDGE_CLIENT_TYPE } from '@bridge/ws/types';
import { HostBridgeWsClient } from '@bridge/ws/ws';
import { isUserPresentAppState, supportsNativePushPresence } from '@shell/session/appVisibility';
import { detectLocalProfileSupport } from '@shell/runtime/localProfileSupport';
import { getActiveBridgeProfile } from '@shell/state/bridgeProfiles';
import {
  isLocalProfile,
  LOCAL_PROFILE,
  LOCAL_PROFILE_ID,
  type ShellProfile,
} from '@shell/state/localProfile';
import { localTransportAtom } from '@shell/state/local/atoms';
import { env } from '@shared/config';
import { bridgeProfilesAtom, bridgeProfileStoreAtom } from '@shell/state/appState/atoms';

const localProfileSupportOverrideAtom = atom<boolean | null>(null);
let detectedLocalProfileSupport: boolean | null = null;

/**
 * Whether the built-in "On this iPhone" profile can open in this build. Writing installs an
 * override, which is the injection seam used by tests.
 */
export const localProfileAvailableAtom = atom(
  (get) =>
    get(localProfileSupportOverrideAtom) ??
    (detectedLocalProfileSupport ??= detectLocalProfileSupport()),
  (_get, set, available: boolean | null) => {
    set(localProfileSupportOverrideAtom, available);
  },
);

/** Every profile the shell can open, bridge profiles first. */
export const shellProfilesAtom = atom<ShellProfile[]>((get) => [
  ...get(bridgeProfilesAtom),
  ...(get(localProfileAvailableAtom) ? [LOCAL_PROFILE] : []),
]);

/**
 * The open profile: a saved bridge profile or the built-in local profile. A persisted local
 * selection resolves to `null` where the local agent is unsupported (Android, web, old builds).
 */
export const activeProfileAtom = atom<ShellProfile | null>((get) => {
  const store = get(bridgeProfileStoreAtom);
  if (store.activeProfileId === LOCAL_PROFILE_ID) {
    return get(localProfileAvailableAtom) ? LOCAL_PROFILE : null;
  }
  return getActiveBridgeProfile(store);
});

export const activeProfileIdAtom = atom((get) => get(activeProfileAtom)?.id ?? null);

export const activeProfileIsLocalAtom = atom((get) => isLocalProfile(get(activeProfileAtom)));

/** The active profile when it is a bridge connection; `null` while the local profile is open. */
export const activeBridgeProfileAtom = atom((get) =>
  getActiveBridgeProfile(get(bridgeProfileStoreAtom)),
);

/** Client-side affordances that depend on the kind of profile rather than on the wire protocol. */
export interface ActiveProfileFeatures {
  /** Attachments are uploaded over the bridge's HTTP endpoint. */
  attachments: boolean;
  pushNotifications: boolean;
  /** Bridge URL/token editing, reconnect, and pairing. */
  connectionSettings: boolean;
  /** Cloning from the workspace picker (`bridge/git/clone`). */
  gitClone: boolean;
}

export const activeProfileFeaturesAtom = atom<ActiveProfileFeatures>((get) => {
  const local = get(activeProfileIsLocalAtom);
  return {
    attachments: !local,
    pushNotifications: !local,
    connectionSettings: !local,
    gitClone: !local,
  };
});

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
    if (get(activeProfileIsLocalAtom)) {
      return get(localTransportAtom);
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
    const local = get(activeProfileIsLocalAtom);
    return new HostBridgeApiClient({
      ws,
      bridgeUrl: bridgeUrl ?? undefined,
      authToken: local ? null : (get(bridgeTokenAtom) ?? env.hostBridgeToken),
      profileId: get(activeProfileIdAtom),
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
