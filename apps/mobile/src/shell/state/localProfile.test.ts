import { Platform } from 'react-native';

import { detectLocalProfileSupport } from '@shell/runtime/localProfileSupport';
import {
  appStateReducer,
  createDefaultAppStateData,
  parsePersistedAppState,
  serializeAppState,
} from '@shell/state/appState';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import {
  activeBridgeProfileAtom,
  activeProfileAtom,
  activeProfileFeaturesAtom,
  localProfileAvailableAtom,
  shellProfilesAtom,
} from '@shell/state/bridge/atoms';
import { parseBridgeProfileStore, setActiveBridgeProfile } from '@shell/state/bridgeProfiles';
import { LOCAL_PROFILE, LOCAL_PROFILE_ID, profileIdentityKey } from '@shell/state/localProfile';
import { createTestStore } from '@shell/state/testing';

const bridge = {
  id: 'bridge-1',
  name: 'Desk',
  bridgeUrl: 'https://desk.test',
  bridgeToken: 'token',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function persisted(settings: Record<string, unknown>, activeProfileId: string | null) {
  return JSON.stringify({
    version: 3,
    settings,
    bridgeProfiles: { activeProfileId, profiles: [bridge] },
    push: {},
  });
}

function storeWith(activeProfileId: string | null, available: boolean) {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = { activeProfileId, profiles: [bridge] };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, available);
  return store;
}

describe('local profile state', () => {
  it('migrates the legacy global on-device mode to the local profile and drops the setting', () => {
    const migrated = parsePersistedAppState(
      persisted({ preferredExecutionTarget: 'on-device', showToolCalls: false }, 'bridge-1'),
    );
    expect(migrated.bridgeProfiles.activeProfileId).toBe(LOCAL_PROFILE_ID);
    expect(migrated.settings).not.toHaveProperty('preferredExecutionTarget');
    expect(migrated.settings.showToolCalls).toBe(false);
    expect(serializeAppState(migrated)).not.toContain('preferredExecutionTarget');

    const desktop = parsePersistedAppState(
      persisted({ preferredExecutionTarget: 'bridge' }, 'bridge-1'),
    );
    expect(desktop.bridgeProfiles.activeProfileId).toBe('bridge-1');
  });

  it('persists the local selection but never an unknown profile id', () => {
    expect(
      parseBridgeProfileStore(JSON.stringify({ activeProfileId: LOCAL_PROFILE_ID, profiles: [] }))
        .activeProfileId,
    ).toBe(LOCAL_PROFILE_ID);
    expect(
      parseBridgeProfileStore(JSON.stringify({ activeProfileId: 'bridge-gone', profiles: [] }))
        .activeProfileId,
    ).toBeNull();
    const store = parseBridgeProfileStore(
      JSON.stringify({ activeProfileId: 'bridge-1', profiles: [bridge] }),
    );
    expect(setActiveBridgeProfile(store, LOCAL_PROFILE_ID).activeProfileId).toBe(LOCAL_PROFILE_ID);
    const switched = appStateReducer(
      { ...createDefaultAppStateData(), bridgeProfiles: store },
      { type: 'profiles/switch', profileId: LOCAL_PROFILE_ID },
    );
    expect(switched.bridgeProfiles.activeProfileId).toBe(LOCAL_PROFILE_ID);
  });

  it('resolves the local profile only where the local agent is supported', () => {
    const supported = storeWith(LOCAL_PROFILE_ID, true);
    expect(supported.get(activeProfileAtom)).toEqual(LOCAL_PROFILE);
    expect(supported.get(activeBridgeProfileAtom)).toBeNull();
    expect(supported.get(shellProfilesAtom).map((profile) => profile.id)).toEqual([
      'bridge-1',
      LOCAL_PROFILE_ID,
    ]);
    expect(supported.get(activeProfileFeaturesAtom)).toEqual({
      attachments: false,
      pushNotifications: false,
      connectionSettings: false,
      gitClone: false,
      browserPreview: false,
    });

    const unsupported = storeWith(LOCAL_PROFILE_ID, false);
    expect(unsupported.get(activeProfileAtom)).toBeNull();
    expect(unsupported.get(shellProfilesAtom).map((profile) => profile.id)).toEqual(['bridge-1']);
    expect(storeWith('bridge-1', true).get(activeProfileFeaturesAtom).attachments).toBe(true);
  });

  it.each(['android', 'web', 'macos'])('never detects local support on %s', (platform) => {
    expect(detectLocalProfileSupport(platform)).toBe(false);
  });

  it('does not detect local support without the native module at the expected ABI', () => {
    expect(Platform.OS).toBe('ios');
    expect(detectLocalProfileSupport('ios')).toBe(false);
  });

  it('keeps separate new-chat workspaces for the local profile and bridges', () => {
    const store = storeWith('bridge-1', true);
    store.set(defaultStartCwdAtom, '/Users/ada/repo');
    const switchTo = (activeProfileId: string) => {
      const snapshot = store.get(appStateSnapshotAtom);
      store.set(appStateSnapshotAtom, {
        ...snapshot,
        data: {
          ...snapshot.data,
          bridgeProfiles: { ...snapshot.data.bridgeProfiles, activeProfileId },
        },
      });
    };
    switchTo(LOCAL_PROFILE_ID);
    expect(store.get(defaultStartCwdAtom)).toBeNull();
    store.set(defaultStartCwdAtom, '/On this iPhone/Demo');
    switchTo('bridge-1');
    expect(store.get(defaultStartCwdAtom)).toBe('/Users/ada/repo');
    switchTo(LOCAL_PROFILE_ID);
    expect(store.get(defaultStartCwdAtom)).toBe('/On this iPhone/Demo');
  });

  it('keys profile-scoped caches by connection identity', () => {
    expect(profileIdentityKey(LOCAL_PROFILE)).not.toBe(profileIdentityKey(bridge));
    expect(profileIdentityKey({ ...bridge, bridgeUrl: 'https://other.test' })).not.toBe(
      profileIdentityKey(bridge),
    );
  });
});
