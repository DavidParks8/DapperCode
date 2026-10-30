jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('../../features/on-device/runtime/OnDeviceProvider', () => {
  const React = jest.requireActual('react');
  const runtime = { id: 'runtime' };
  return {
    mockRuntime: runtime,
    OnDeviceProvider: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children),
    useOnDeviceRuntime: () => runtime,
  };
});
jest.mock('../../features/on-device/transport/runtimePort', () => {
  const { FakeAgentPort } = jest.requireActual('../../features/on-device/transport/testing');
  return { createRuntimeAgentPort: () => new FakeAgentPort() };
});

import { router } from 'expo-router';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { createDefaultAppStateData } from '@shell/state/appState';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { localProfileAvailableAtom, wsClientAtom } from '@shell/state/bridge/atoms';
import { localRuntimeAtom, localTransportAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore, withAppStore } from '@shell/state/testing';
import { LocalRuntimeHost } from './LocalRuntimeHost';

function storeWith(activeProfileId: string, available = true) {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId,
    profiles: [
      {
        id: 'bridge-1',
        name: 'Desk',
        bridgeUrl: 'https://desk.test',
        bridgeToken: 'token',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, available);
  return store;
}

function setActive(store: ReturnType<typeof storeWith>, activeProfileId: string) {
  const snapshot = store.get(appStateSnapshotAtom);
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: { ...snapshot.data.bridgeProfiles, activeProfileId },
    },
  });
}

function render(store: ReturnType<typeof storeWith>): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(withAppStore(store, <LocalRuntimeHost />));
  });
  return tree!;
}

describe('LocalRuntimeHost', () => {
  beforeEach(() => {
    act(() => router.replace('/profiles/bridge-1/chats/new'));
  });

  it('owns a runtime and transport only while the local profile is open', () => {
    const store = storeWith('bridge-1');
    const tree = render(store);
    expect(store.get(localTransportAtom)).toBeNull();

    act(() => setActive(store, LOCAL_PROFILE_ID));
    const transport = store.get(localTransportAtom);
    expect(transport?.isConnected).toBe(true);
    expect(store.get(wsClientAtom)).toBe(transport);
    expect(store.get(localRuntimeAtom)).toEqual({ id: 'runtime' });

    act(() => setActive(store, 'bridge-1'));
    expect(store.get(localTransportAtom)).toBeNull();
    expect(store.get(localRuntimeAtom)).toBeNull();
    expect(transport?.isConnected).toBe(false);
    act(() => tree.unmount());
  });

  it('keeps the runtime for legacy on-device screens and never mounts where unsupported', () => {
    const store = storeWith('bridge-1');
    act(() => router.replace('/on-device/models'));
    const tree = render(store);
    expect(store.get(localRuntimeAtom)).not.toBeNull();
    act(() => tree.unmount());
    expect(store.get(localRuntimeAtom)).toBeNull();

    const unsupported = storeWith(LOCAL_PROFILE_ID, false);
    const hidden = render(unsupported);
    expect(unsupported.get(localTransportAtom)).toBeNull();
    expect((hidden as unknown as { toJSON: () => unknown }).toJSON()).toBeNull();
    act(() => hidden.unmount());
  });
});
