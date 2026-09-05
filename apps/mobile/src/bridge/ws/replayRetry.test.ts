import type { RpcNotification } from '@bridge/types/types';
import { HostBridgeWsClient } from '@bridge/ws/ws';
import { requireTestValue } from '@shared/testing/requireTestValue';

class ReplaySocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  send = jest.fn<void, [string]>();
  close = jest.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  identity(streamId = 'stream-a', protocolVersion = 2): void {
    this.receive({ method: 'bridge/connection/state', streamId, protocolVersion });
  }

  requests(): { id: string; params: { afterEventId: number } }[] {
    return this.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .filter((payload) => payload.method === 'bridge/events/replay');
  }

  latestRequest(): { id: string; params: { afterEventId: number } } {
    return requireTestValue(this.requests().at(-1), 'replay request');
  }

  fail(code = -32000): void {
    this.receive({ id: this.latestRequest().id, error: { code, message: 'replay unavailable' } });
  }

  replay(events: RpcNotification[], latestEventId = 12, streamId = 'stream-a'): void {
    this.receive({
      id: this.latestRequest().id,
      result: {
        protocolVersion: 2,
        streamId,
        earliestEventId: 1,
        latestEventId,
        hasMore: false,
        events,
      },
    });
  }
}

function event(eventId: number, type = 'TEXT_MESSAGE_CONTENT'): RpcNotification {
  return {
    method: 'bridge/agui.event',
    protocolVersion: 2,
    streamId: 'stream-a',
    eventId,
    params: {
      threadId: 'thread',
      runId: 'turn',
      sourceTurnId: 'turn',
      event: { type, threadId: 'thread', runId: 'turn', delta: 'text' },
    },
  };
}

describe('connected replay retries', () => {
  let client: HostBridgeWsClient;
  let sockets: ReplaySocket[];
  let delivered: RpcNotification[];

  const deliveredIds = () => delivered.flatMap(({ eventId }) => eventId ?? []);
  const settle = () => jest.advanceTimersByTimeAsync(0);
  const open = () => {
    client.connect();
    const socket = requireTestValue(sockets.at(-1), 'socket');
    socket.onopen?.();
    socket.identity();
    return socket;
  };
  const gap = async () => {
    const socket = open();
    socket.receive(event(10));
    socket.receive(event(12, 'RUN_FINISHED'));
    await settle();
    expect(deliveredIds()).toEqual([10]);
    expect(socket.requests()).toHaveLength(1);
    return socket;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    sockets = [];
    delivered = [];
    globalThis.WebSocket = jest.fn(() => {
      const socket = new ReplaySocket();
      sockets.push(socket);
      return socket;
    }) as unknown as typeof WebSocket;
    client = new HostBridgeWsClient('http://localhost:8787', { requestTimeoutMs: 100 });
    client.onEvent((notification) => delivered.push(notification));
  });

  afterEach(async () => {
    client.disconnect();
    await settle();
    jest.restoreAllMocks();
    jest.useRealTimers();
    Reflect.deleteProperty(globalThis, 'WebSocket');
  });

  it.each(['RPC error', 'timeout'])(
    'recovers a silent connected gap after a transient %s, delivering completion exactly once',
    async (failure) => {
      const socket = await gap();
      const completed = jest.fn();
      const waiting = client.waitForTurnCompletion('thread', 'turn', 5_000).then(completed);
      if (failure === 'RPC error') {
        socket.fail();
        await settle();
      } else {
        await jest.advanceTimersByTimeAsync(100);
      }
      expect(client.isConnected).toBe(true);
      expect(completed).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(499);
      expect(socket.requests()).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(socket.requests()).toHaveLength(2);
      expect(socket.latestRequest().params.afterEventId).toBe(10);
      expect(deliveredIds()).toEqual([10]);

      socket.replay([event(11), event(12, 'RUN_FINISHED')]);
      await settle();
      await waiting;
      expect(deliveredIds()).toEqual([10, 11, 12]);
      expect(completed).toHaveBeenCalledTimes(1);
      socket.receive(event(12, 'RUN_FINISHED'));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(deliveredIds()).toEqual([10, 11, 12]);
      expect(socket.requests()).toHaveLength(2);
      expect(sockets).toHaveLength(1);
      expect(client.isConnected).toBe(true);
    },
  );

  it('caps exponential backoff, does not let live traffic bypass it, and resets after success', async () => {
    const socket = await gap();
    let requests = 1;
    for (const delay of [500, 1_000, 2_000, 4_000, 5_000, 5_000]) {
      socket.fail();
      await settle();
      socket.receive(event(13 + requests));
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(socket.requests()).toHaveLength(requests);
      await jest.advanceTimersByTimeAsync(1);
      requests += 1;
      expect(socket.requests()).toHaveLength(requests);
    }
    socket.replay(
      Array.from({ length: 9 }, (_, index) => event(index + 11)),
      19,
    );
    await settle();
    expect(deliveredIds()).toEqual(Array.from({ length: 10 }, (_, index) => index + 10));
    socket.receive(event(21));
    await settle();
    socket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    expect(socket.requests()).toHaveLength(requests + 2);
  });

  it('keeps one request in flight when more events and connection notifications arrive', async () => {
    const socket = await gap();
    socket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    for (const id of [13, 14, 15]) {
      socket.receive(event(id));
      socket.identity();
    }
    await settle();
    expect(socket.requests()).toHaveLength(2);
    socket.replay(
      Array.from({ length: 5 }, (_, index) => event(index + 11)),
      15,
    );
    await settle();
    expect(deliveredIds()).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('cancels a scheduled retry when live events fill the gap', async () => {
    const socket = await gap();
    socket.fail();
    await settle();
    socket.receive(event(11));
    expect(deliveredIds()).toEqual([10, 11, 12]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socket.requests()).toHaveLength(1);
  });

  it('retries reconnect replay even without any buffered live events', async () => {
    const socket = open();
    socket.receive(event(10));
    client.disconnect();
    const nextSocket = open();
    await settle();
    nextSocket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    expect(nextSocket.requests()).toHaveLength(2);
    nextSocket.replay([event(11, 'RUN_FINISHED')], 11);
    await settle();
    expect(deliveredIds()).toEqual([10, 11]);
  });

  it('backs off a successful replay response that makes no progress instead of hot-looping', async () => {
    const socket = await gap();
    socket.replay([], 10);
    await settle();
    expect(socket.requests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(500);
    expect(socket.requests()).toHaveLength(2);
    socket.replay([event(11)]);
    await settle();
    expect(deliveredIds()).toEqual([10, 11, 12]);
  });

  it('adds bounded reconnect-style jitter to the retry delay', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const socket = await gap();
    socket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(748);
    expect(socket.requests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(socket.requests()).toHaveLength(2);
  });

  it.each(['disconnect', 'close', 'error'] as const)(
    'cancels retry on %s and preserves the buffered gap for reconnect',
    async (action) => {
      const socket = await gap();
      socket.fail();
      await settle();
      if (action === 'disconnect') {
        client.disconnect();
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(60_000);
      } else if (action === 'close') {
        socket.close();
      } else {
        socket.onerror?.();
      }
      expect(client.isConnected).toBe(false);
      if (action !== 'disconnect') {
        await jest.advanceTimersByTimeAsync(500);
      }
      const nextSocket = open();
      await settle();
      expect(nextSocket.latestRequest().params.afterEventId).toBe(10);
      nextSocket.replay([event(11)]);
      await settle();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(socket.requests()).toHaveLength(1);
      expect(nextSocket.requests()).toHaveLength(1);
      expect(deliveredIds()).toEqual([10, 11, 12]);
    },
  );

  it('does not let an old rejected request cancel the new connection retry', async () => {
    const socket = await gap();
    client.disconnect();
    const nextSocket = open();
    await settle();
    nextSocket.fail();
    socket.fail(-32601);
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    expect(nextSocket.requests()).toHaveLength(2);
    nextSocket.replay([event(11)]);
    await settle();
    expect(deliveredIds()).toEqual([10, 11, 12]);
  });

  it.each(['scheduled', 'in flight'])(
    'fences %s retry work after a stream change',
    async (state) => {
      const socket = await gap();
      const oldRequest = socket.latestRequest();
      if (state === 'scheduled') {
        socket.fail();
        await settle();
      }
      socket.identity('stream-b');
      socket.receive({ ...event(20), streamId: 'stream-b' });
      expect(client.acknowledgeSnapshotRecovery(0)).toBe(true);
      socket.receive({ ...event(22), streamId: 'stream-b' });
      await settle();
      socket.fail();
      await settle();
      socket.receive({
        id: oldRequest.id,
        error: { code: -32601, message: 'stale unsupported reply' },
      });
      await settle();
      await jest.advanceTimersByTimeAsync(500);
      expect(socket.requests()).toHaveLength(3);
      expect(socket.latestRequest().params.afterEventId).toBe(20);
      socket.replay([{ ...event(21), streamId: 'stream-b' }], 22, 'stream-b');
      await settle();
      expect(deliveredIds()).toEqual([10, 20, 21, 22]);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(socket.requests()).toHaveLength(3);
    },
  );

  it('cancels retry when resetting the recovery epoch', async () => {
    const socket = await gap();
    socket.fail();
    await settle();
    client.resetRecoveryEpoch();
    const nextSocket = requireTestValue(sockets.at(-1), 'new recovery socket');
    expect(nextSocket).not.toBe(socket);
    nextSocket.onopen?.();
    nextSocket.identity();
    await settle();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socket.requests()).toHaveLength(1);
    expect(nextSocket.requests()).toHaveLength(0);
    expect(client.acknowledgeSnapshotRecovery(0)).toBe(true);
  });

  it('never retries an unsupported replay method', async () => {
    const socket = await gap();
    socket.fail(-32601);
    await settle();
    socket.receive(event(13));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socket.requests()).toHaveLength(1);
    expect(deliveredIds()).toEqual([10]);
  });

  it.each(['scheduled', 'in flight'])(
    'cancels %s replay work on a fatal protocol error',
    async (state) => {
      const socket = await gap();
      if (state === 'scheduled') {
        socket.fail();
        await settle();
      }
      socket.identity('stream-a', 99);
      await settle();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(socket.requests()).toHaveLength(1);
      expect(sockets).toHaveLength(1);
      expect(client.bridgeProtocolError?.receivedVersion).toBe(99);
      expect(client.isConnected).toBe(false);
    },
  );

  it('stops retries at a snapshot boundary and preserves its ACK and buffer across disconnect', async () => {
    const socket = await gap();
    socket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    socket.receive({
      id: socket.latestRequest().id,
      result: {
        protocolVersion: 2,
        streamId: 'stream-a',
        earliestEventId: 20,
        latestEventId: 25,
        events: [],
      },
    });
    await settle();
    socket.receive(event(27, 'RUN_FINISHED'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socket.requests()).toHaveLength(2);
    expect(deliveredIds()).toEqual([10]);
    expect(
      delivered.filter(({ method }) => method === 'bridge/events/snapshotRequired'),
    ).toHaveLength(1);
    client.disconnect();
    const nextSocket = open();
    await settle();
    expect(nextSocket.requests()).toHaveLength(0);
    expect(client.acknowledgeSnapshotRecovery(24)).toBe(false);
    expect(client.acknowledgeSnapshotRecovery(25)).toBe(true);
    await settle();
    nextSocket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    expect(nextSocket.requests()).toHaveLength(2);
    expect(nextSocket.latestRequest().params.afterEventId).toBe(25);
    nextSocket.replay([event(26)], 27);
    await settle();
    expect(deliveredIds()).toEqual([10, 26, 27]);
  });

  it('fetches a silent reconnect tail after the pending snapshot is acknowledged', async () => {
    const socket = await gap();
    socket.fail();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    socket.receive({
      id: socket.latestRequest().id,
      result: {
        protocolVersion: 2,
        streamId: 'stream-a',
        earliestEventId: 20,
        latestEventId: 25,
        events: [],
      },
    });
    await settle();
    client.disconnect();
    const nextSocket = open();
    await settle();
    expect(nextSocket.requests()).toHaveLength(0);
    expect(client.acknowledgeSnapshotRecovery(25)).toBe(true);
    await settle();
    expect(nextSocket.requests()).toHaveLength(1);
    expect(nextSocket.latestRequest().params.afterEventId).toBe(25);
    nextSocket.replay([event(26, 'RUN_FINISHED')], 26);
    await settle();
    expect(deliveredIds()).toEqual([10, 26]);
  });
});
