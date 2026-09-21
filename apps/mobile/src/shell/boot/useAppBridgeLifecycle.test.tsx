const mockBindAppWebSocketLifecycle = jest.fn((ws: unknown) => {
  void ws;
  return jest.fn();
});
const mockBindPushForegroundPresence = jest.fn((ws: unknown) => {
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

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@shell/session/webSocketLifecycle', () => ({
  bindAppWebSocketLifecycle: (ws: unknown) => mockBindAppWebSocketLifecycle(ws),
}));
jest.mock('@shell/push/presence', () => ({
  bindPushForegroundPresence: (ws: unknown) => mockBindPushForegroundPresence(ws),
}));
jest.mock('@shell/push/controller', () => ({
  syncPushRegistration: (api: unknown, store: unknown, profileId: unknown) =>
    mockSyncPushRegistration(api, store, profileId),
}));
jest.mock('@shell/state/bridge/capabilitiesLifecycle', () => ({
  bindBridgeCapabilitiesRevalidation: (ws: unknown, revalidate: unknown) =>
    mockBindCapabilities(ws, revalidate),
}));
jest.mock('../../features/workspace/state/workspaceLifecycle', () => ({
  bindWorkspaceResourcesRevalidation: (ws: unknown, revalidate: unknown) =>
    mockBindWorkspaceResources(ws, revalidate),
}));
jest.mock('@shell/state/bridge/capabilities', () => {
  const actual = jest.requireActual('@shell/state/bridge/capabilities');
  const { atom } = jest.requireActual('jotai');
  return {
    ...actual,
    revalidateBridgeCapabilitiesAtom: atom(null, () => mockRevalidateCapabilities()),
  };
});
jest.mock('../../features/workspace/state/workspaceActions', () => {
  const actual = jest.requireActual('../../features/workspace/state/workspaceActions');
  const { atom } = jest.requireActual('jotai');
  return {
    ...actual,
    revalidateWorkspacePickerResourcesAtom: atom(null, () => mockRevalidateWorkspace()),
  };
});
jest.mock('@shell/state/appState/actions', () => {
  const actual = jest.requireActual('@shell/state/appState/actions');
  const { atom } = jest.requireActual('jotai');
  return {
    ...actual,
    initializeAppStateAtom: atom(null, async () => undefined),
  };
});
jest.mock('@shell/session/chatSnapshotCache', () => {
  const actual = jest.requireActual('@shell/session/chatSnapshotCache');
  return {
    ...actual,
    loadChatSnapshotCache: jest.fn().mockResolvedValue(null),
    saveChatSnapshotCache: jest.fn().mockResolvedValue(undefined),
  };
});

import { router } from 'expo-router';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { requestApprovalPolicySyncAtom } from '@shell/state/approvalPolicy';
import { approvalModeAtom } from '@shell/state/appState/settings';
import {
  activeChatAtom,
  chatSnapshotCacheAtom,
  interruptedChatCreationAtom,
  selectedChatIdAtom,
} from '@shell/state/chat/atoms';
import {
  createEmptyChatSnapshotCache,
  updateChatSnapshotCache,
  loadChatSnapshotCache,
  saveChatSnapshotCache,
} from '@shell/session/chatSnapshotCache';
import type { Chat } from '@bridge/types/types';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { useAppBridgeLifecycle } from '@shell/boot/useAppBridgeLifecycle';
import { consumeInterruptedChatCreationAtom } from '@shell/state/chat/actions';

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

  it('keeps interrupted creation durable until its recovered draft is consumed', async () => {
    const at = new Date().toISOString();
    const pending: Chat = {
      id: 'pending-recovery',
      title: '',
      status: 'running',
      createdAt: at,
      updatedAt: at,
      statusUpdatedAt: at,
      lastMessagePreview: 'Recover',
      messages: [{ id: 'msg-recovery', role: 'user', content: 'Recover', createdAt: at }],
    };
    const cache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-1'),
      pending.id,
      pending,
    );
    jest.mocked(loadChatSnapshotCache).mockResolvedValueOnce(cache);
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
      setApprovalPolicy: jest.fn().mockResolvedValue(undefined),
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: true,
      onStatus: jest.fn(() => jest.fn()),
    } as unknown as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    router.replace('/profiles/profile-1/chats/new');
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(store.get(interruptedChatCreationAtom)?.draft).toBe('Recover');
    expect(api.rememberChat).not.toHaveBeenCalled();
    expect(saveChatSnapshotCache).not.toHaveBeenCalled();
    expect(store.get(chatSnapshotCacheAtom)?.selectedChatId).toBe(pending.id);
    const real = { ...pending, id: 'v1.YWdlbnQ.c2Vzc2lvbg' };
    await act(async () => {
      store.set(activeChatAtom, real);
      store.set(selectedChatIdAtom, real.id);
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(store.get(chatSnapshotCacheAtom)?.selectedChatId).toBe(pending.id);
    expect(saveChatSnapshotCache).not.toHaveBeenCalled();
    await act(async () => {
      await store.set(consumeInterruptedChatCreationAtom, {
        expectedPendingChatId: pending.id,
        replacement: real,
      });
      await Promise.resolve();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(store.get(chatSnapshotCacheAtom)?.selectedChatId).toBe(real.id);
    expect(jest.mocked(saveChatSnapshotCache).mock.calls.at(-1)?.[0].selectedChatId).toBe(real.id);
    act(() => tree?.unmount());
  });

  it('suppresses background work during connection and enables workspace/chat lifecycles by route', async () => {
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
      setApprovalPolicy: jest.fn().mockResolvedValue(undefined),
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
    expect(mockBindPushForegroundPresence).toHaveBeenCalledWith(ws);
    expect(mockBindAppWebSocketLifecycle).toHaveBeenCalledWith(ws);

    act(() => tree?.unmount());
  });

  it('pushes the persisted approval policy on boot and reconnect', async () => {
    const setApprovalPolicy = jest.fn().mockResolvedValue(undefined);
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
      setApprovalPolicy,
    } as unknown as HostBridgeApiClient;
    const statusListeners = new Set<(connected: boolean) => void>();
    let connected = true;
    const ws = {
      get isConnected() {
        return connected;
      },
      onStatus: jest.fn((listener: (connected: boolean) => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      }),
    } as unknown as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    store.set(approvalModeAtom, 'none');
    router.replace('/profiles/profile-1/chats/new');

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(setApprovalPolicy).toHaveBeenCalledTimes(1);
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('never');

    await act(async () => {
      connected = false;
      statusListeners.forEach((listener) => listener(false));
      connected = true;
      statusListeners.forEach((listener) => listener(true));
      await Promise.resolve();
    });

    expect(setApprovalPolicy).toHaveBeenCalledTimes(2);
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('never');
    act(() => tree?.unmount());
  });

  it('reconciles a newer local mode after an older boot sync finishes', async () => {
    let resolveInitialSync!: () => void;
    const initialSync = new Promise<void>((resolve) => {
      resolveInitialSync = resolve;
    });
    const setApprovalPolicy = jest
      .fn()
      .mockReturnValueOnce(initialSync)
      .mockResolvedValue(undefined);
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
      setApprovalPolicy,
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: true,
      onStatus: jest.fn(() => jest.fn()),
    } as unknown as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    router.replace('/profiles/profile-1/chats/new');

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('untrusted');

    store.set(approvalModeAtom, 'none');
    await act(async () => {
      resolveInitialSync();
      await initialSync;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setApprovalPolicy).toHaveBeenCalledTimes(2);
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('never');
    act(() => tree?.unmount());
  });

  it('retries a failed approval policy sync', async () => {
    const setApprovalPolicy = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockResolvedValue(undefined);
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
      setApprovalPolicy,
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: true,
      onStatus: jest.fn(() => jest.fn()),
    } as unknown as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    store.set(approvalModeAtom, 'some');
    router.replace('/profiles/profile-1/chats/new');

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setApprovalPolicy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(setApprovalPolicy).toHaveBeenCalledTimes(2);
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('on-request');
    act(() => tree?.unmount());
  });

  it('retries an unacknowledged local policy change without waiting for reconnect', async () => {
    const setApprovalPolicy = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockResolvedValue(undefined);
    const api = {
      primeChats: jest.fn().mockResolvedValue(undefined),
      rememberChat: jest.fn(),
      setApprovalPolicy,
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: true,
      onStatus: jest.fn(() => jest.fn()),
    } as unknown as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    store.set(approvalModeAtom, 'none');
    router.replace('/profiles/profile-1/chats/new');

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('never');

    await act(async () => {
      store.set(approvalModeAtom, 'all');
      store.set(requestApprovalPolicySyncAtom);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setApprovalPolicy).toHaveBeenCalledTimes(2);
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('untrusted');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(setApprovalPolicy).toHaveBeenCalledTimes(3);
    expect(setApprovalPolicy).toHaveBeenLastCalledWith('untrusted');
    act(() => tree?.unmount());
  });
});
