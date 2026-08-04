import { Provider } from 'jotai';
import { createElement, type ReactElement, type ReactNode } from 'react';

import type { AgentId, Chat } from '@bridge/types/types';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import {
  createDefaultAppStateData,
  type AppStateAction,
  type AppStateData,
  type AppStatePersistenceAdapter,
  type AppStateSnapshot,
} from '@shell/state/appState';
import {
  dispatchAppStateAtom,
  dispatchDurableAppStateAtom,
  flushPersistenceAtom,
  initializeAppStateAtom,
  retryPersistenceAtom,
} from '@shell/state/appState/actions';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { apiClientAtom, wsClientAtom } from '@shell/state/bridge/atoms';
import { pendingMainChatIdAtom, pendingMainChatSnapshotAtom } from '@shell/state/chat/atoms';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { createAppStore } from '@shell/state/store';
import type { AppStore } from '@shell/state/types';

export interface MemoryPersistence extends AppStatePersistenceAdapter {
  writes: string[];
}

export function createMemoryPersistence(
  options: { current?: string | null } = {},
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

export interface CreateBridgeTestStoreOptions {
  api: HostBridgeApiClient;
  ws?: HostBridgeWsClient;
  bridgeUrl?: string;
  bridgeProfileId?: string;
  preferredAgentId?: AgentId | null;
  defaultStartCwd?: string | null;
  recentBrowserTargetUrls?: string[];
  pendingOpenChatId?: string | null;
  pendingOpenChatSnapshot?: Chat | null;
}

/** Builds a loaded store with an active bridge profile and injected bridge clients. */
export function createBridgeTestStore(options: CreateBridgeTestStoreOptions): AppStore {
  const profileId = options.bridgeProfileId ?? 'profile-1';
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId: profileId,
    profiles: [
      {
        id: profileId,
        name: 'Bridge',
        bridgeUrl: options.bridgeUrl ?? 'https://bridge.test',
        bridgeToken: 'token',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  data.settings = {
    ...data.settings,
    preferredAgentId: options.preferredAgentId ?? null,
    defaultStartCwd: options.defaultStartCwd ?? null,
    recentBrowserTargetUrls: options.recentBrowserTargetUrls ?? [],
  };
  const store = createTestStore({ data });
  store.set(apiClientAtom, options.api);
  if (options.ws) {
    store.set(wsClientAtom, options.ws);
  }
  store.set(drawerCommandsAtom, {
    closeDrawer: () => undefined,
    toggleNavigation: () => undefined,
  });
  store.set(pendingMainChatIdAtom, options.pendingOpenChatId ?? null);
  store.set(pendingMainChatSnapshotAtom, options.pendingOpenChatSnapshot ?? null);
  return store;
}
