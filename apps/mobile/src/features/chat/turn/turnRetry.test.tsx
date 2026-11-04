import { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { LocalBridgeServer } from '../../on-device/transport/server';
import { FakeAgentPort } from '../../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { activityAtom } from '../state/composer';
import { errorAtom, sendingAtom } from '../state/turn';
import { useFailedTurnRetry, type FailedTurnRetry, type TurnRetryLifecycle } from './turnRetry';

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve();
  }
}

function failedChat(id: string): Chat {
  return { id, status: 'error', lastError: 'The local context window is full.' } as Chat;
}

async function setup() {
  const port = new FakeAgentPort();
  const ws = new LocalBridgeWsClient(new LocalBridgeServer(port));
  ws.connect();
  const api = new HostBridgeApiClient({ ws, profileId: LOCAL_PROFILE_ID });
  const store = createBridgeTestStore({ api, ws, bridgeProfileId: 'bridge-1' });
  store.set(localProfileAvailableAtom, true);
  const snapshot = store.get(appStateSnapshotAtom);
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: { ...snapshot.data.bridgeProfiles, activeProfileId: LOCAL_PROFILE_ID },
    },
  });

  // Two chats whose last turns failed.
  const ids: string[] = [];
  for (const name of ['a', 'b']) {
    const chat = await api.createChatIdempotent({ cwd: DEMO }, `create-${name}`);
    await api.sendChatMessageIdempotent(chat.id, { content: name, cwd: DEMO }, `send-${name}`);
    port.settle(chat.id, 'failed', 'The local context window is full.');
    ids.push(chat.id);
  }

  const selectedChatIdRef: { current: string | null } = { current: ids[0]! };
  const lifecycle = {
    selectedChatIdRef,
    registerTurnStarted: jest.fn<void, [string, string]>(),
    handleTurnFailure: jest.fn<void, [unknown]>(),
  } satisfies TurnRetryLifecycle;
  let latest: FailedTurnRetry | null = null;
  function Probe({ chat }: { chat: Chat }) {
    latest = useFailedTurnRetry({
      selectedChat: chat,
      visibleError: null,
      running: false,
      lifecycle,
    });
    return null;
  }
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(withAppStore(store, <Probe chat={failedChat(ids[0]!)} />));
    await flush();
  });
  const open = async (id: string) => {
    // Opening a chat resets the shared turn state, as chat navigation does.
    lifecycle.selectedChatIdRef.current = id;
    store.set(sendingAtom, false);
    store.set(errorAtom, null);
    await act(async () => {
      tree!.update(withAppStore(store, <Probe chat={failedChat(id)} />));
      await flush();
    });
  };
  return { port, store, ids, lifecycle, open, retry: () => latest, tree: () => tree! };
}

describe('useFailedTurnRetry', () => {
  it('counts a retry that reloads its model as sending, so the composer offers Stop', async () => {
    const { port, store, ids, lifecycle, retry, tree } = await setup();
    port.holdModelLoad = true;

    await act(async () => {
      retry()!.retry();
      await flush();
    });
    expect(port.run()).toMatchObject({ phase: 'preparing', threadId: ids[0] });
    expect(store.get(sendingAtom)).toBe(true);
    expect(retry()!.retrying).toBe(true);

    await act(async () => {
      port.finishModelLoad();
      await flush();
    });
    expect(lifecycle.registerTurnStarted).toHaveBeenCalledWith(
      ids[0],
      port.thread(ids[0]!)!.activeTurnId,
    );
    expect(store.get(sendingAtom)).toBe(false);
    act(() => tree().unmount());
  });

  it('settles a failed retry through the shared turn failure for its own chat', async () => {
    const { port, store, lifecycle, retry, tree } = await setup();
    port.holdModelLoad = true;
    await act(async () => {
      retry()!.retry();
      await flush();
    });

    await act(async () => {
      port.failModelLoad('Not enough memory to load Qwen3 1.7B.');
      await flush();
    });
    expect(lifecycle.handleTurnFailure).toHaveBeenCalledTimes(1);
    expect(String(lifecycle.handleTurnFailure.mock.calls[0]![0])).toContain('Not enough memory');
    expect(store.get(sendingAtom)).toBe(false);
    act(() => tree().unmount());
  });

  it("keeps a retry's failure off a chat opened while it was loading", async () => {
    const { port, store, ids, lifecycle, open, retry, tree } = await setup();
    port.holdModelLoad = true;
    await act(async () => {
      retry()!.retry();
      await flush();
    });

    await open(ids[1]!);
    expect(store.get(sendingAtom)).toBe(false);

    await act(async () => {
      port.failModelLoad('Not enough memory to load Qwen3 1.7B.');
      await flush();
    });
    expect(lifecycle.handleTurnFailure).not.toHaveBeenCalled();
    expect(lifecycle.registerTurnStarted).not.toHaveBeenCalled();
    expect(store.get(errorAtom)).toBeNull();
    expect(store.get(activityAtom).tone).not.toBe('error');
    expect(store.get(sendingAtom)).toBe(false);
    act(() => tree().unmount());
  });

  it('shows Stop again when the user returns to the chat that is still retrying', async () => {
    const { port, store, ids, open, retry, tree } = await setup();
    port.holdModelLoad = true;
    await act(async () => {
      retry()!.retry();
      await flush();
    });

    await open(ids[1]!);
    expect(store.get(sendingAtom)).toBe(false);
    await open(ids[0]!);
    expect(store.get(sendingAtom)).toBe(true);
    expect(retry()!.retrying).toBe(true);
    act(() => tree().unmount());
  });
});
