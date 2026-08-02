import { createElement } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { ChatSummary } from '@bridge/types/types';
import * as ChatSummaryCache from '@shell/session/chatSummaryCache';
import {
  DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS,
  useDrawerChatCollection,
} from '@shell/navigation/useDrawerChatCollection';

jest.mock('@shell/session/chatSummaryCache', () => {
  const actual = jest.requireActual('@shell/session/chatSummaryCache');
  return {
    ...actual,
    loadChatSummaryCache: jest.fn(),
    persistChatSummaries: jest.fn().mockResolvedValue(undefined),
  };
});

function summary(id: string): ChatSummary {
  return {
    id,
    title: `Chat ${id}`,
    status: 'complete',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    statusUpdatedAt: '2026-07-01T00:00:00.000Z',
    lastMessagePreview: id,
  };
}

type HookResult = ReturnType<typeof useDrawerChatCollection>;

function renderCollection(
  api: HostBridgeApiClient,
  profileId: string | null,
  onChatsApplied: () => void,
): { latest: () => HookResult; tree: ReactTestRenderer } {
  let latestResult!: HookResult;
  function Probe() {
    latestResult = useDrawerChatCollection(api, profileId, onChatsApplied);
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(createElement(Probe));
  });
  return { latest: () => latestResult, tree };
}

/**
 * Regression coverage for the hydration side of the chat-summary-cache
 * purge barrier: `hydratePersistedChats` reads the persisted cache
 * asynchronously, so a purge (bridge profile delete/clear, or an in-place
 * identity edit) can land while that read is still in flight. Applying a
 * stale read afterward would show - and, via later persistence, could
 * re-write - old-identity summaries under the (still valid) profile id.
 */
describe('useDrawerChatCollection hydration purge barrier', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('discards a persisted-cache hydration that resolves after a purge lands mid-flight', async () => {
    const api = { rememberChats: jest.fn() } as unknown as HostBridgeApiClient;
    const onChatsApplied = jest.fn();
    let resolveLoad!: (cache: ChatSummaryCache.ChatSummaryCache) => void;
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockImplementation(
      () =>
        new Promise<ChatSummaryCache.ChatSummaryCache>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const { latest } = renderCollection(api, 'profile-1', onChatsApplied);

    let hydratePromise!: Promise<void>;
    act(() => {
      hydratePromise = latest().hydratePersistedChats();
    });

    // A purge lands while the persisted-cache read above is still pending -
    // e.g. the user deleted, cleared, or edited-in-place the bridge profile
    // whose id ('profile-1') this drawer is bound to.
    await ChatSummaryCache.deleteChatSummaryCache('profile-1');

    await act(async () => {
      resolveLoad(
        ChatSummaryCache.mergeChatSummaryCache(
          ChatSummaryCache.createEmptyChatSummaryCache('profile-1'),
          [summary('stale-before-purge')],
        ),
      );
      await hydratePromise;
    });

    expect(latest().chats).toEqual([]);
  });

  it('hydrates normally when no purge lands during the read (regression guard)', async () => {
    const api = { rememberChats: jest.fn() } as unknown as HostBridgeApiClient;
    const onChatsApplied = jest.fn();
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockResolvedValue(
      ChatSummaryCache.mergeChatSummaryCache(
        ChatSummaryCache.createEmptyChatSummaryCache('profile-1'),
        [summary('kept')],
      ),
    );

    const { latest } = renderCollection(api, 'profile-1', onChatsApplied);
    await act(async () => {
      await latest().hydratePersistedChats();
    });

    expect(latest().chats.map((chat) => chat.id)).toEqual(['kept']);
  });
});

/**
 * Regression coverage for the scheduling side of the chat-summary-cache
 * purge barrier: `schedulePersistence` used to carry a previously buffered
 * batch forward - and stamp the merged result with the *current*
 * generation - whenever the profile id matched, without checking whether
 * the buffered batch's own generation was still current. An in-place bridge
 * identity edit (or delete/clear) that purges the cache and bumps the
 * barrier between two schedule calls would then let the stale, pre-purge
 * summaries ride along under the new generation and pass the barrier check
 * at flush time, resurrecting data the purge had just removed.
 */
describe('useDrawerChatCollection schedulePersistence purge barrier', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('drops a pending pre-purge batch when an in-place identity edit lands before reschedule, keeping only post-purge summaries', async () => {
    const profileId = 'profile-schedule-barrier';
    const api = { rememberChats: jest.fn() } as unknown as HostBridgeApiClient;
    const onChatsApplied = jest.fn();
    const persistChatSummaries = ChatSummaryCache.persistChatSummaries as jest.Mock;
    persistChatSummaries.mockClear();

    const { latest } = renderCollection(api, profileId, onChatsApplied);

    // Schedule summaries under generation N.
    act(() => {
      latest().applyChats([summary('stale-before-purge')], undefined, true, false);
    });

    // An in-place bridge identity edit purges the cache before the debounce
    // timer fires, bumping the barrier to N+1.
    await act(async () => {
      await ChatSummaryCache.deleteChatSummaryCache(profileId);
    });

    // A fresh schedule lands under the new generation, still before the
    // original debounce window has elapsed.
    act(() => {
      latest().applyChats([summary('post-purge')], undefined, true, false);
    });

    // Advance past the debounce window so the buffered batch flushes.
    await act(async () => {
      jest.advanceTimersByTime(DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(persistChatSummaries).toHaveBeenCalledTimes(1);
    const [persistedProfileId, persistedSummaries, , persistedGeneration] =
      persistChatSummaries.mock.calls[0];
    expect(persistedProfileId).toBe(profileId);
    expect((persistedSummaries as ChatSummary[]).map((chat) => chat.id)).toEqual(['post-purge']);
    expect(persistedGeneration).toBe(ChatSummaryCache.getChatSummaryCacheGeneration(profileId));
  });

  it('still coalesces multiple schedules into one write when no purge lands (regression guard)', async () => {
    const profileId = 'profile-schedule-coalesce';
    const api = { rememberChats: jest.fn() } as unknown as HostBridgeApiClient;
    const onChatsApplied = jest.fn();
    const persistChatSummaries = ChatSummaryCache.persistChatSummaries as jest.Mock;
    persistChatSummaries.mockClear();

    const { latest } = renderCollection(api, profileId, onChatsApplied);

    act(() => {
      latest().applyChats([summary('first')], undefined, true, false);
    });
    act(() => {
      latest().applyChats([summary('second')], undefined, true, false);
    });

    await act(async () => {
      jest.advanceTimersByTime(DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(persistChatSummaries).toHaveBeenCalledTimes(1);
    const [, persistedSummaries] = persistChatSummaries.mock.calls[0];
    expect((persistedSummaries as ChatSummary[]).map((chat) => chat.id).sort()).toEqual([
      'first',
      'second',
    ]);
  });

  it('still flushes the pending batch immediately when the profile id changes (regression guard)', async () => {
    const api = { rememberChats: jest.fn() } as unknown as HostBridgeApiClient;
    const onChatsApplied = jest.fn();
    const persistChatSummaries = ChatSummaryCache.persistChatSummaries as jest.Mock;
    persistChatSummaries.mockClear();

    let activeProfileId = 'profile-switch-a';
    function Probe() {
      latestResult = useDrawerChatCollection(api, activeProfileId, onChatsApplied);
      return null;
    }
    let latestResult!: HookResult;
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(createElement(Probe));
    });

    act(() => {
      latestResult.applyChats([summary('for-a')], undefined, true, false);
    });

    activeProfileId = 'profile-switch-b';
    act(() => {
      tree.update(createElement(Probe));
    });

    // Switching profiles must flush the previous profile's pending batch
    // right away rather than waiting for the debounce timer.
    expect(persistChatSummaries).toHaveBeenCalledTimes(1);
    expect(persistChatSummaries.mock.calls[0][0]).toBe('profile-switch-a');
    expect((persistChatSummaries.mock.calls[0][1] as ChatSummary[]).map((chat) => chat.id)).toEqual(
      ['for-a'],
    );
  });
});
