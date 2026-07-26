import { createStore, Provider } from 'jotai';
import { createElement, type PropsWithChildren, type ReactElement } from 'react';
import { Appearance } from 'react-native';

import type { AppStatePersistenceAdapter } from '../appState';
import { createAppStatePersistence } from '../appStatePersistence';
import { appStatePersistenceAdapterAtom, appStoreRefAtom } from './appState/atoms';
import { systemColorSchemeAtom } from './theme';
import type { AppStore } from './types';

export interface CreateAppStoreOptions {
  persistence?: AppStatePersistenceAdapter;
}

export function createAppStore(options: CreateAppStoreOptions = {}): AppStore {
  const store = createStore();
  store.set(appStoreRefAtom, store);
  store.set(systemColorSchemeAtom, Appearance.getColorScheme() ?? 'unspecified');
  store.set(
    appStatePersistenceAdapterAtom,
    options.persistence ?? createAppStatePersistence()
  );
  return store;
}

export function AppStateProvider({
  store,
  children,
}: PropsWithChildren<{ store: AppStore }>): ReactElement {
  return createElement(Provider, { store }, children);
}

export type { AppStore };
