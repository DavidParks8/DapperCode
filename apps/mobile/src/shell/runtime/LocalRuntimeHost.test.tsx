jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('../../features/on-device/runtime/OnDeviceProvider', () => {
  const React = jest.requireActual('react');
  const listeners = new Set<() => void>();
  const state = {
    downloaded: true,
    workspaces: [{ id: 'ws-one', name: 'Demo', isRepository: true }],
  };
  const runtime = {
    id: 'runtime',
    preferences: () => ({ modelId: 'qwen3-1.7b-q4-k-m', workspaceId: null }),
    threads: { list: () => [] },
    downloads: {
      snapshot: () => ({ phase: state.downloaded ? 'ready' : 'idle', bytesWritten: 0 }),
    },
    workspaces: () => state.workspaces,
    loop: {
      snapshot: () => ({
        phase: 'idle',
        threadId: null,
        turnId: null,
        toolName: null,
        approval: null,
      }),
    },
    models: {
      snapshot: () => ({
        phase: 'empty',
        modelId: null,
        progress: 0,
        error: null,
        contextTokens: null,
      }),
    },
    workspaceActivity: () => null,
    legacyDrafts: () => new Map(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change: (update: Partial<typeof state>) => {
      Object.assign(state, update);
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
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
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import {
  localAgentPresenceAtom,
  localRuntimeAtom,
  localTransportAtom,
} from '@shell/state/local/atoms';
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
    expect(store.get(localRuntimeAtom)).toMatchObject({ id: 'runtime' });

    act(() => setActive(store, 'bridge-1'));
    expect(store.get(localTransportAtom)).toBeNull();
    expect(store.get(localRuntimeAtom)).toBeNull();
    expect(transport?.isConnected).toBe(false);
    act(() => tree.unmount());
  });

  it('publishes the local agent status and new-chat readiness, and seeds the workspace', () => {
    const { mockRuntime } = jest.requireMock<{
      mockRuntime: { change: (update: Record<string, unknown>) => void };
    }>('../../features/on-device/runtime/OnDeviceProvider');
    const store = storeWith(LOCAL_PROFILE_ID);
    const tree = render(store);

    expect(store.get(defaultStartCwdAtom)).toBe('/On this iPhone/Demo');
    expect(store.get(localAgentPresenceAtom)).toEqual({
      status: { label: 'Qwen3 1.7B Q4_K_M · loads when you send', kind: 'ready' },
      readiness: null,
      defaultWorkspacePath: '/On this iPhone/Demo',
    });

    act(() => mockRuntime.change({ downloaded: false }));
    expect(store.get(localAgentPresenceAtom)?.readiness).toEqual({
      reason: 'Download Qwen3 1.7B Q4_K_M to start a conversation.',
      action: 'download-model',
    });
    expect(store.get(localAgentPresenceAtom)?.status.kind).toBe('attention');

    act(() => setActive(store, 'bridge-1'));
    expect(store.get(localAgentPresenceAtom)).toBeNull();
    act(() => mockRuntime.change({ downloaded: true }));
    act(() => tree.unmount());
  });

  it('never covers onboarding with local runtime pages', () => {
    const store = storeWith(LOCAL_PROFILE_ID);
    act(() => router.replace('/onboarding'));
    const tree = render(store);
    expect((tree as unknown as { toJSON: () => unknown }).toJSON()).toBeNull();
    expect(store.get(localRuntimeAtom)).toBeNull();
    act(() => tree.unmount());
  });

  it('owns no runtime outside the local profile, even at a retired /on-device link, or where unsupported', () => {
    const store = storeWith('bridge-1');
    act(() => router.replace('/on-device/models'));
    const tree = render(store);
    expect(store.get(localRuntimeAtom)).toBeNull();
    expect((tree as unknown as { toJSON: () => unknown }).toJSON()).toBeNull();
    act(() => tree.unmount());

    const unsupported = storeWith(LOCAL_PROFILE_ID, false);
    const hidden = render(unsupported);
    expect(unsupported.get(localTransportAtom)).toBeNull();
    expect((hidden as unknown as { toJSON: () => unknown }).toJSON()).toBeNull();
    act(() => hidden.unmount());
  });
});
