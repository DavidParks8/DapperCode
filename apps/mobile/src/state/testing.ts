import { Provider } from 'jotai';
import { createElement, type ReactElement, type ReactNode } from 'react';

import {
  createDefaultAppStateData,
  type AppStateAction,
  type AppStateData,
  type AppStatePersistenceAdapter,
  type AppStateSnapshot,
  type LegacyAppStateSource,
} from '../appState';
import {
  dispatchAppStateAtom,
  dispatchDurableAppStateAtom,
  flushPersistenceAtom,
  initializeAppStateAtom,
  retryPersistenceAtom,
} from './appState/actions';
import { appStateSnapshotAtom } from './appState/atoms';
import { createAppStore } from './store';
import type { AppStore } from './types';

export interface MemoryPersistence extends AppStatePersistenceAdapter {
  writes: string[];
}

export function createMemoryPersistence(
  options: { current?: string | null; legacy?: LegacyAppStateSource } = {}
): MemoryPersistence {
  let current = options.current ?? null;
  const writes: string[] = [];
  return {
    writes,
    readCurrent: () => Promise.resolve(current),
    writeCurrent: (raw) => {
      current = raw;
      writes.push(raw);
      return Promise.resolve();
    },
    readLegacy: () =>
      Promise.resolve(options.legacy ?? { settingsRaw: null, bridgeProfilesRaw: null }),
  };
}

export interface CreateTestStoreOptions {
  persistence?: AppStatePersistenceAdapter;
  data?: AppStateData;
  loaded?: boolean;
}

/**
 * Creates a store that is already "loaded" by default so tests can hydrate atom values
 * without going through persistence.
 */
export function createTestStore(options: CreateTestStoreOptions = {}): AppStore {
  const store = createAppStore({ persistence: options.persistence ?? createMemoryPersistence() });
  store.set(appStateSnapshotAtom, {
    loaded: options.loaded ?? true,
    data: options.data ?? createDefaultAppStateData(),
    persistenceError: null,
  });
  return store;
}

export interface AppStateHarness {
  store: AppStore;
  initialize: () => Promise<void>;
  dispatch: (action: AppStateAction) => void;
  dispatchDurable: (action: AppStateAction) => Promise<AppStateData>;
  retryPersistence: () => Promise<void>;
  flushPersistence: () => Promise<void>;
  getSnapshot: () => AppStateSnapshot;
  subscribe: (listener: () => void) => () => void;
}

/** Thin call-through facade over the app-state atoms for tests that drive persistence. */
export function createAppStateHarness(persistence: AppStatePersistenceAdapter): AppStateHarness {
  const store = createAppStore({ persistence });
  return {
    store,
    initialize: () => store.set(initializeAppStateAtom),
    dispatch: (action) => store.set(dispatchAppStateAtom, action),
    dispatchDurable: (action) => store.set(dispatchDurableAppStateAtom, action),
    retryPersistence: () => store.set(retryPersistenceAtom),
    flushPersistence: () => store.set(flushPersistenceAtom),
    getSnapshot: () => store.get(appStateSnapshotAtom),
    subscribe: (listener) => store.sub(appStateSnapshotAtom, listener),
  };
}

/** Wraps a tree so it resolves atoms from the supplied store. */
export function withAppStore(store: AppStore, children: ReactNode): ReactElement {
  return createElement(Provider, { store }, children);
}
