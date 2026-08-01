jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('../testing/gestureHandlerMock'),
);
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual('react');
  return {
    initialWindowMetrics: null,
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});
jest.mock('./useAppBridgeLifecycle', () => ({ useAppBridgeLifecycle: jest.fn() }));
jest.mock('./useAppStoreReview', () => ({ useAppStoreReview: jest.fn() }));
jest.mock('./usePushNotificationsLifecycle', () => ({
  usePushNotificationsLifecycle: jest.fn(),
}));

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppStatePersistenceError } from '../appState';
import { appStateSnapshotAtom } from '../state/appState/atoms';
import { chatSnapshotCacheAtom } from '../state/chat/atoms';
import { createTestStore, withAppStore } from '../state/testing';
import { RootLayout } from './RootLayout';

function renderRoot(store = createTestStore()): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(withAppStore(store, <RootLayout />));
  });
  if (!tree) throw new Error('Expected root layout');
  return tree;
}

function jsonOf(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
}

describe('RootLayout', () => {
  it('shows the startup shell until persisted state and chat cache are ready', () => {
    const store = createTestStore({ loaded: false });
    const tree = renderRoot(store);
    expect(jsonOf(tree)).toContain('Loading DapperCode');
    act(() => tree.unmount());
  });

  it('shows typed read recovery without hiding write-only failures', () => {
    const store = createTestStore();
    store.set(chatSnapshotCacheAtom, null);
    store.set(appStateSnapshotAtom, {
      ...store.get(appStateSnapshotAtom),
      persistenceError: new AppStatePersistenceError('read_failed', 'load', 'read failed'),
    });
    const readTree = renderRoot(store);
    expect(jsonOf(readTree)).toContain('Could not load saved app state');
    act(() => readTree.unmount());

    store.set(appStateSnapshotAtom, {
      ...store.get(appStateSnapshotAtom),
      persistenceError: new AppStatePersistenceError('write_failed', 'write', 'write failed'),
    });
    const writeTree = renderRoot(store);
    expect(jsonOf(writeTree)).not.toContain('Could not load saved app state');
    act(() => writeTree.unmount());
  });
});
