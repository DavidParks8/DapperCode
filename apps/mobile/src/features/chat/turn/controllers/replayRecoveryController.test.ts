import type { HostBridgeApiClient } from '@bridge/client/client';
import type { BridgeCapabilities, Chat } from '@bridge/types/types';
import { RpcRequestError } from '@bridge/ws/errors';
import {
  collectReplayRecoveryThreadIds,
  fetchReplayRecoverySnapshot,
  REPLAY_RECOVERY_CONCURRENCY,
  REPLAY_RECOVERY_MAX_LOADED_THREADS,
  ReplayRecoveryProtocolError,
} from './replayRecoveryController';

const capabilities = { agents: [] } as unknown as BridgeCapabilities;

function chat(id: string): Chat {
  return { id, messages: [] } as unknown as Chat;
}

function createApi() {
  return {
    listLoadedChatIds: jest.fn().mockResolvedValue(['selected', 'background-b', 'loaded-new']),
    listApprovals: jest.fn().mockResolvedValue([{ id: 'approval', threadId: 'background-a' }]),
    listPendingUserInputs: jest.fn().mockResolvedValue([{ id: 'input', threadId: 'background-b' }]),
    readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
    getChat: jest.fn((threadId: string) => Promise.resolve(chat(threadId))),
    readThreadQueue: jest.fn((threadId: string) => Promise.resolve({ threadId })),
    readThreadSchedules: jest.fn((threadId: string) =>
      Promise.resolve({ threadId, schedules: [] }),
    ),
  } as unknown as jest.Mocked<HostBridgeApiClient>;
}

describe('replay recovery controller', () => {
  it('deduplicates tracked IDs and ignores empty IDs', () => {
    expect(
      collectReplayRecoveryThreadIds([
        [' selected ', null],
        ['selected', '', 'background'],
      ]),
    ).toEqual(['selected', 'background']);
  });

  it('expands through loaded threads and pending interactions before returning one snapshot', async () => {
    const api = createApi();
    const result = await fetchReplayRecoverySnapshot(api, ['selected', 'background-a']);

    expect(result.threads.map(({ chat: value }) => value.id)).toEqual([
      'selected',
      'background-a',
      'background-b',
      'loaded-new',
    ]);
    expect(result.approvals).toHaveLength(1);
    expect(result.userInputs).toHaveLength(1);
    expect(result.capabilities).toBe(capabilities);
    expect(result.threads[0]?.schedules).toEqual({ threadId: 'selected', schedules: [] });
    expect(api.getChat).toHaveBeenCalledTimes(4);
    expect(api.readThreadQueue).toHaveBeenCalledTimes(4);
    expect(api.readThreadSchedules).toHaveBeenCalledTimes(4);
  });

  it('excludes deleted threads from tracked, loaded, and pending recovery sources', async () => {
    const api = createApi();
    const result = await fetchReplayRecoverySnapshot(
      api,
      ['selected', 'deleted'],
      undefined,
      new Set(['deleted', 'loaded-new', 'background-a', 'background-b']),
    );

    expect(result.threads.map(({ chat: value }) => value.id)).toEqual(['selected']);
    expect(api.getChat).toHaveBeenCalledWith('selected', { forceRefresh: true });
    expect(api.readThreadQueue).toHaveBeenCalledWith('selected');
    expect(api.readThreadSchedules).toHaveBeenCalledWith('selected');
    expect(api.getChat).toHaveBeenCalledTimes(1);
    expect(api.readThreadQueue).toHaveBeenCalledTimes(1);
    expect(api.readThreadSchedules).toHaveBeenCalledTimes(1);
  });

  it('rejects the entire snapshot when one late thread fails and refetches all threads on retry', async () => {
    const api = createApi();
    api.listApprovals.mockResolvedValue([]);
    api.listPendingUserInputs.mockResolvedValue([]);
    api.listLoadedChatIds.mockResolvedValue([
      'thread-0',
      'thread-1',
      'thread-2',
      'thread-3',
      'thread-4',
    ]);
    api.getChat.mockImplementation((threadId) =>
      threadId === 'thread-4'
        ? Promise.reject(new Error('background unavailable'))
        : Promise.resolve(chat(threadId)),
    );

    await expect(fetchReplayRecoverySnapshot(api, [])).rejects.toThrow('background unavailable');
    const failedAttemptCalls = api.getChat.mock.calls.length;
    api.getChat.mockImplementation((threadId) => Promise.resolve(chat(threadId)));
    await expect(fetchReplayRecoverySnapshot(api, [])).resolves.toMatchObject({
      threads: expect.any(Array),
    });
    expect(api.getChat.mock.calls.length - failedAttemptCalls).toBe(5);
    expect(api.readThreadQueue.mock.calls.length - failedAttemptCalls).toBe(5);
    expect(api.readThreadSchedules.mock.calls.length - failedAttemptCalls).toBe(5);
  });

  it('recovers surviving and unloaded history alongside authoritatively missing cached threads', async () => {
    const api = createApi();
    api.getChat.mockImplementation((threadId) =>
      threadId === 'deleted'
        ? Promise.reject(
            new RpcRequestError('thread/read', -32004, 'Thread not found', {
              error: 'thread_not_found',
              threadId,
            }),
          )
        : Promise.resolve(chat(threadId)),
    );
    const result = await fetchReplayRecoverySnapshot(api, ['deleted', 'unloaded-history']);
    expect(result).toMatchObject({ missingThreadIds: ['deleted'] });
    expect(result.threads.map(({ chat: value }) => value.id)).toEqual([
      'unloaded-history',
      'selected',
      'background-b',
      'loaded-new',
      'background-a',
    ]);
  });

  it.each([
    new Error('unknown ACP session deleted'),
    new RpcRequestError('thread/read', -32000, 'Thread not found'),
    new RpcRequestError('thread/read', -32004, 'Thread not found'),
    new RpcRequestError('thread/read', -32004, 'Thread not found', {
      error: 'thread_not_found',
      threadId: 'another-thread',
    }),
  ])('never interprets an unconfirmed read failure as deletion (%s)', async (error) => {
    const api = createApi();
    api.getChat.mockRejectedValue(error);
    await expect(fetchReplayRecoverySnapshot(api, ['deleted'])).rejects.toBe(error);
  });

  it('does not hide a transient auxiliary read failure behind a missing thread', async () => {
    const api = createApi();
    api.getChat.mockRejectedValue(
      new RpcRequestError('thread/read', -32004, 'Thread not found', {
        error: 'thread_not_found',
        threadId: 'selected',
      }),
    );
    api.readThreadQueue.mockRejectedValue(new Error('queue unavailable'));
    await expect(fetchReplayRecoverySnapshot(api, [])).rejects.toThrow('queue unavailable');
  });

  it.each([201, REPLAY_RECOVERY_MAX_LOADED_THREADS])(
    'fetches every snapshot and queue for %i loaded threads with concurrency at most four',
    async (threadCount) => {
      const api = createApi();
      api.listApprovals.mockResolvedValue([]);
      api.listPendingUserInputs.mockResolvedValue([]);
      api.listLoadedChatIds.mockResolvedValue(
        Array.from({ length: threadCount }, (_, index) => `thread-${index}`),
      );
      let active = 0;
      let maximumActive = 0;
      api.getChat.mockImplementation(async (threadId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return chat(threadId);
      });
      const recovery = await fetchReplayRecoverySnapshot(api, []);
      expect(recovery.threads).toHaveLength(threadCount);
      expect(api.getChat).toHaveBeenCalledTimes(threadCount);
      expect(api.readThreadQueue).toHaveBeenCalledTimes(threadCount);
      expect(api.readThreadSchedules).toHaveBeenCalledTimes(threadCount);
      expect(maximumActive).toBeLessThanOrEqual(REPLAY_RECOVERY_CONCURRENCY);
    },
  );

  it('fails with a protocol error before thread reads when the bridge loaded list exceeds its maximum', async () => {
    const api = createApi();
    api.listLoadedChatIds.mockResolvedValue(
      Array.from(
        { length: REPLAY_RECOVERY_MAX_LOADED_THREADS + 1 },
        (_, index) => `thread-${index}`,
      ),
    );
    await expect(fetchReplayRecoverySnapshot(api, [])).rejects.toBeInstanceOf(
      ReplayRecoveryProtocolError,
    );
    expect(api.getChat).not.toHaveBeenCalled();
  });

  it('aborts a stale recovery promptly without dispatching the remaining threads', async () => {
    const api = createApi();
    api.listLoadedChatIds.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => `thread-${index}`),
    );
    api.getChat.mockImplementation(() => new Promise<Chat>(() => {}));
    const controller = new AbortController();
    const recovery = fetchReplayRecoverySnapshot(api, [], controller.signal);
    while (api.getChat.mock.calls.length < REPLAY_RECOVERY_CONCURRENCY) {
      await Promise.resolve();
    }
    controller.abort(new Error('stale watermark'));
    await expect(recovery).rejects.toThrow('stale watermark');
    expect(api.getChat).toHaveBeenCalledTimes(REPLAY_RECOVERY_CONCURRENCY);
    expect(api.readThreadQueue).toHaveBeenCalledTimes(REPLAY_RECOVERY_CONCURRENCY);
    expect(api.readThreadSchedules).toHaveBeenCalledTimes(REPLAY_RECOVERY_CONCURRENCY);
  });
});
