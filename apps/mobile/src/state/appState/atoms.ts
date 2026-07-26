import { atom } from 'jotai';

import {
  createDefaultAppStateData,
  type AppStatePersistenceAdapter,
  type AppStateSnapshot,
} from '../../appState';
import type { AppStore } from '../types';

const INITIAL_SNAPSHOT: AppStateSnapshot = {
  loaded: false,
  data: createDefaultAppStateData(),
  persistenceError: null,
};

/**
 * Holds the jotai store that owns these atoms so the persistence coordinator can publish
 * outside of a React render.
 */
export const appStoreRefAtom = atom<AppStore | null>(null);

export const appStatePersistenceAdapterAtom = atom<AppStatePersistenceAdapter | null>(null);

export const appStateSnapshotAtom = atom<AppStateSnapshot>(INITIAL_SNAPSHOT);

export const appStateLoadedAtom = atom((get) => get(appStateSnapshotAtom).loaded);

export const appStateDataAtom = atom((get) => get(appStateSnapshotAtom).data);

export const appStatePersistenceErrorAtom = atom(
  (get) => get(appStateSnapshotAtom).persistenceError
);

export const appSettingsAtom = atom((get) => get(appStateDataAtom).settings);

export const bridgeProfileStoreAtom = atom((get) => get(appStateDataAtom).bridgeProfiles);

export const bridgeProfilesAtom = atom((get) => get(bridgeProfileStoreAtom).profiles);

export const activeBridgeProfileIdAtom = atom((get) => get(bridgeProfileStoreAtom).activeProfileId);

export const pushSettingsAtom = atom((get) => get(appStateDataAtom).push);

export function requireAppStore(store: AppStore | null): AppStore {
  if (!store) {
    throw new Error('The jotai store was not created with createAppStore().');
  }
  return store;
}
