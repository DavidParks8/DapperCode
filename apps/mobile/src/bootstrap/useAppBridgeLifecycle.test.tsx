const mockBindAppWebSocketLifecycle = jest.fn((ws: unknown) => {
  void ws;
  return jest.fn();
});
const mockSyncPushRegistration = jest.fn().mockResolvedValue(undefined);
const mockBindCapabilities = jest.fn((ws: unknown, revalidate: unknown) => {
  void ws;
  void revalidate;
  return jest.fn();
});
const mockBindWorkspaceResources = jest.fn((ws: unknown, revalidate: unknown) => {
  void ws;
  void revalidate;
  return jest.fn();
});
const mockRevalidateCapabilities = jest.fn();
const mockRevalidateWorkspace = jest.fn();

jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));
jest.mock('../appWebSocketLifecycle', () => ({
  bindAppWebSocketLifecycle: (ws: unknown) => mockBindAppWebSocketLifecycle(ws),
}));
jest.mock('../pushController', () => ({
  syncPushRegistration: (api: unknown, store: unknown, profileId: unknown) =>
    mockSyncPushRegistration(api, store, profileId),
}));
jest.mock('../state/bridge/capabilitiesLifecycle', () => ({
  bindBridgeCapabilitiesRevalidation: (ws: unknown, revalidate: unknown) =>
    mockBindCapabilities(ws, revalidate),
}));
jest.mock('../state/mainScreen/workspaceLifecycle', () => ({
  bindWorkspaceResourcesRevalidation: (ws: unknown, revalidate: unknown) =>
    mockBindWorkspaceResources(ws, revalidate),
}));
jest.mock('../state/bridge/capabilities', () => {
  const actual = jest.requireActual('../state/bridge/capabilities');
  const { atom } = jest.requireActual('jotai');
  return {
    ...actual,
    revalidateBridgeCapabilitiesAtom: atom(null, () => mockRevalidateCapabilities()),
  };
});
jest.mock('../state/mainScreen/workspaceActions', () => {
  const actual = jest.requireActual('../state/mainScreen/workspaceActions');
  const { atom } = jest.requireActual('jotai');
  return {
    ...actual,
    revalidateWorkspacePickerResourcesAtom: atom(null, () => mockRevalidateWorkspace()),
  };
});
jest.mock('../state/appState/actions', () => {
  const actual = jest.requireActual('../state/appState/actions');
  const { atom } = jest.requireActual('jotai');
  return {
    ...actual,
    initializeAppStateAtom: atom(null, async () => undefined),
  };
});
jest.mock('../chatSnapshotCache', () => {
  const actual = jest.requireActual('../chatSnapshotCache');
  return {
    ...actual,
    loadChatSnapshotCache: jest.fn().mockResolvedValue(null),
    saveChatSnapshotCache: jest.fn().mockResolvedValue(undefined),
  };
});

import { router } from 'expo-router';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../api/client';
import type { HostBridgeWsClient } from '../api/ws';
import { chatSnapshotCacheAtom } from '../state/chat/atoms';
import { createBridgeTestStore, withAppStore } from '../state/testing';
import { useAppBridgeLifecycle } from './useAppBridgeLifecycle';

function Harness() {
  useAppBridgeLifecycle();
  return null;
}

describe('useAppBridgeLifecycle route gates', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('suppresses background work during connection and enables workspace/chat lifecycles by route', async () => {
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: true,
      onStatus: jest.fn(() => jest.fn()),
    } as unknown as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    store.set(chatSnapshotCacheAtom, null);
    router.replace('/profiles/profile-1/chats/new/connection');

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
      await jest.runOnlyPendingTimersAsync();
    });

    expect(mockSyncPushRegistration).not.toHaveBeenCalled();
    expect(api.primeChats).not.toHaveBeenCalled();

    await act(async () => {
      router.replace('/profiles/profile-1/chats/new/workspace-picker');
      await Promise.resolve();
    });
    expect(mockBindWorkspaceResources).toHaveBeenCalled();

    await act(async () => {
      router.replace('/profiles/profile-1/chats/new');
      await Promise.resolve();
      await jest.runOnlyPendingTimersAsync();
    });
    expect(mockSyncPushRegistration).toHaveBeenCalled();
    expect(api.primeChats).toHaveBeenCalled();
    expect(mockBindAppWebSocketLifecycle).toHaveBeenCalledWith(ws);

    act(() => tree?.unmount());
  });
});
