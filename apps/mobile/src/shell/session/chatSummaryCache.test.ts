import * as FileSystem from 'expo-file-system/legacy';

import type { ChatSummary } from '@bridge/types/types';
import {
  CHAT_SUMMARY_CACHE_MAX_BYTES,
  CHAT_SUMMARY_CACHE_MAX_ENTRIES,
  createEmptyChatSummaryCache,
  deleteChatSummaryCache,
  deletePersistedChatSummary,
  getChatSummaryCacheGeneration,
  getChatSummaryCachePath,
  loadChatSummaryCache,
  mergeChatSummaryCache,
  parseChatSummaryCache,
  persistChatSummaries,
  reconcileChatSummaryCache,
  reconcilePersistedChatSummaries,
  removeChatSummaryFromCache,
  saveChatSummaryCache,
} from '@shell/session/chatSummaryCache';

function summary(id: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: `Chat ${id}`,
    status: 'complete',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    statusUpdatedAt: '2026-07-01T00:00:00.000Z',
    lastMessagePreview: id,
    cwd: '/workspace',
    ...overrides,
  };
}

describe('chatSummaryCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses the current format, migrates v0, and rejects corruption', () => {
    const current = mergeChatSummaryCache(
      createEmptyChatSummaryCache('profile-a'),
      [summary('one')],
      '2026-07-17T00:00:00.000Z',
    );
    expect(
      parseChatSummaryCache(
        JSON.stringify(current),
        'profile-a',
        Date.parse('2026-07-18T00:00:00.000Z'),
      ),
    ).toEqual(current);

    const migrated = parseChatSummaryCache(
      JSON.stringify({
        version: 0,
        profileId: 'profile-a',
        updatedAt: '2026-07-17T00:00:00.000Z',
        chats: [{ ...summary('legacy'), authToken: 'must-not-survive' }, { id: 'malformed' }, null],
      }),
      'profile-a',
      Date.parse('2026-07-18T00:00:00.000Z'),
    );
    expect(migrated).toMatchObject({
      version: 1,
      lastSuccessfulRefreshAt: '2026-07-17T00:00:00.000Z',
      entries: [{ summary: { id: 'legacy' }, cachedAt: '2026-07-17T00:00:00.000Z' }],
    });
    expect(migrated.entries[0]?.summary).not.toHaveProperty('authToken');

    expect(parseChatSummaryCache('{', 'profile-a').entries).toEqual([]);
    expect(
      parseChatSummaryCache(
        JSON.stringify({ version: 99, profileId: 'profile-a', entries: [] }),
        'profile-a',
      ).entries,
    ).toEqual([]);
    expect(
      parseChatSummaryCache(
        JSON.stringify({
          version: 1,
          profileId: 'profile-a',
          entries: [{ summary: { id: 'broken' }, cachedAt: 'invalid' }],
        }),
        'profile-a',
      ).entries,
    ).toEqual([]);
  });

  it('isolates profiles, expires old entries, and never retains unknown fields', () => {
    const raw = JSON.stringify({
      version: 1,
      profileId: 'profile-a',
      updatedAt: '2026-07-17T00:00:00.000Z',
      lastSuccessfulRefreshAt: '2026-07-17T00:00:00.000Z',
      entries: [
        {
          summary: { ...summary('one'), authToken: 'must-not-persist' },
          cachedAt: '2026-07-17T00:00:00.000Z',
        },
        {
          summary: summary('old'),
          cachedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const parsed = parseChatSummaryCache(raw, 'profile-a', Date.parse('2026-07-18T00:00:00.000Z'));
    expect(parsed.entries.map((entry) => entry.summary.id)).toEqual(['one']);
    expect(parsed.entries[0]?.summary).not.toHaveProperty('authToken');
    expect(parseChatSummaryCache(raw, 'profile-b').entries).toEqual([]);
    expect(getChatSummaryCachePath('a/b', 'file:///documents/')).toContain('a%2Fb');
  });

  it('bounds entries and UTF-8 bytes while retaining newest summaries', () => {
    const chats = Array.from({ length: CHAT_SUMMARY_CACHE_MAX_ENTRIES + 20 }, (_, index) =>
      summary(`thread-${String(index)}`, {
        updatedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      }),
    );
    const bounded = mergeChatSummaryCache(createEmptyChatSummaryCache('profile-a'), chats);
    expect(bounded.entries).toHaveLength(CHAT_SUMMARY_CACHE_MAX_ENTRIES);
    expect(bounded.entries[0]?.summary.id).toBe(`thread-${CHAT_SUMMARY_CACHE_MAX_ENTRIES + 19}`);

    const oversized = mergeChatSummaryCache(createEmptyChatSummaryCache('profile-a'), [
      summary('huge', { lastMessagePreview: '🙂'.repeat(CHAT_SUMMARY_CACHE_MAX_BYTES) }),
      summary('small'),
    ]);
    expect(oversized.entries.map((entry) => entry.summary.id)).toEqual(['small']);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThanOrEqual(
      CHAT_SUMMARY_CACHE_MAX_BYTES,
    );
  });

  it('bounds in linear serialized work instead of repeatedly encoding the growing cache', () => {
    const chats = Array.from({ length: CHAT_SUMMARY_CACHE_MAX_ENTRIES }, (_, index) =>
      summary(`thread-${String(index)}`, {
        lastMessagePreview: `${'界🙂'.repeat(250)}-${String(index)}`,
        updatedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      }),
    );
    const originalStringify = JSON.stringify;
    let serializedBytes = 0;
    const stringify = jest.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      const serialized = originalStringify(value);
      serializedBytes += Buffer.byteLength(serialized, 'utf8');
      return serialized;
    });

    const bounded = mergeChatSummaryCache(createEmptyChatSummaryCache('profile-a'), chats);
    stringify.mockRestore();
    const finalBytes = Buffer.byteLength(originalStringify(bounded), 'utf8');

    expect(bounded.entries).toHaveLength(CHAT_SUMMARY_CACHE_MAX_ENTRIES);
    expect(finalBytes).toBeLessThanOrEqual(CHAT_SUMMARY_CACHE_MAX_BYTES);
    expect(serializedBytes).toBeLessThan(finalBytes * 3);
  });

  it('merges fresher rows, retains stale rows, and removes deleted rows', () => {
    const initial = mergeChatSummaryCache(
      createEmptyChatSummaryCache('profile-a'),
      [summary('stale'), summary('updated', { title: 'Old title' })],
      '2026-07-17T00:00:00.000Z',
    );
    const refreshed = mergeChatSummaryCache(
      initial,
      [
        summary('updated', {
          title: 'New title',
          updatedAt: '2026-07-18T00:00:00.000Z',
          statusUpdatedAt: '2026-07-18T00:00:00.000Z',
        }),
        summary('new'),
      ],
      '2026-07-18T00:00:00.000Z',
    );
    expect(refreshed.entries.map((entry) => entry.summary.id)).toEqual(['updated', 'stale', 'new']);
    expect(refreshed.entries.find((entry) => entry.summary.id === 'updated')?.summary.title).toBe(
      'New title',
    );
    expect(removeChatSummaryFromCache(refreshed, 'stale').entries).toHaveLength(2);
  });

  it('reconciles an authoritative listing by pruning absent cached summaries', () => {
    const initial = mergeChatSummaryCache(
      createEmptyChatSummaryCache('profile-a'),
      [summary('deleted-on-host'), summary('kept', { title: 'Old title' })],
      '2026-07-17T00:00:00.000Z',
    );
    const reconciled = reconcileChatSummaryCache(
      initial,
      [
        summary('kept', {
          title: 'Current title',
          updatedAt: '2026-07-18T00:00:00.000Z',
        }),
      ],
      '2026-07-18T00:00:00.000Z',
    );

    expect(reconciled.entries).toEqual([
      expect.objectContaining({
        summary: expect.objectContaining({ id: 'kept', title: 'Current title' }),
      }),
    ]);
  });

  it('serializes writes and makes persisted deletion win', async () => {
    const originalDirectory = FileSystem.documentDirectory;
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: 'file:///documents/',
    });
    let stored: string | null = null;
    jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
    jest.spyOn(FileSystem, 'readAsStringAsync').mockImplementation(async () => {
      if (stored === null) {
        throw new Error('missing');
      }
      return stored;
    });
    const write = jest
      .spyOn(FileSystem, 'writeAsStringAsync')
      .mockImplementation(async (_path, raw) => {
        stored = raw;
      });

    await Promise.all([
      persistChatSummaries('profile-a', [summary('one')]),
      persistChatSummaries('profile-a', [summary('two')]),
    ]);
    await deletePersistedChatSummary('profile-a', 'one');
    await expect(loadChatSummaryCache('profile-a')).resolves.toMatchObject({
      entries: [{ summary: { id: 'two' } }],
    });
    expect(write).toHaveBeenCalledTimes(3);

    await reconcilePersistedChatSummaries('profile-a', [summary('authoritative')]);
    await expect(loadChatSummaryCache('profile-a')).resolves.toMatchObject({
      entries: [{ summary: { id: 'authoritative' } }],
    });
    expect(write).toHaveBeenCalledTimes(4);

    const loaded = await loadChatSummaryCache('profile-a');
    await Promise.all([saveChatSummaryCache(loaded), saveChatSummaryCache(loaded)]);
    expect(write).toHaveBeenCalledTimes(6);
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: originalDirectory,
    });
  });

  describe('purge generation barrier', () => {
    function mockFileSystem() {
      const originalDirectory = FileSystem.documentDirectory;
      Object.defineProperty(FileSystem, 'documentDirectory', {
        configurable: true,
        value: 'file:///documents/',
      });
      let stored: string | null = null;
      jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
      jest.spyOn(FileSystem, 'readAsStringAsync').mockImplementation(async () => {
        if (stored === null) {
          throw new Error('missing');
        }
        return stored;
      });
      const write = jest
        .spyOn(FileSystem, 'writeAsStringAsync')
        .mockImplementation(async (_path, raw) => {
          stored = raw;
        });
      const del = jest.spyOn(FileSystem, 'deleteAsync').mockImplementation(async () => {
        stored = null;
      });
      return {
        write,
        del,
        restore: () => {
          Object.defineProperty(FileSystem, 'documentDirectory', {
            configurable: true,
            value: originalDirectory,
          });
        },
      };
    }

    it('drops a write scheduled before a purge even when it is only issued after the purge completes', async () => {
      const { write, restore } = mockFileSystem();
      try {
        // A normal write establishes the baseline cache and generation 0.
        await persistChatSummaries('profile-purge', [summary('kept')]);
        const staleGeneration = getChatSummaryCacheGeneration('profile-purge');

        // Delete/clear/in-place-edit flows call deleteChatSummaryCache, which
        // bumps the barrier *before* the deletion is queued and completes.
        await deleteChatSummaryCache('profile-purge');
        expect(getChatSummaryCacheGeneration('profile-purge')).not.toBe(staleGeneration);
        await expect(loadChatSummaryCache('profile-purge')).resolves.toMatchObject({
          entries: [],
        });

        const writesBeforeStaleFlush = write.mock.calls.length;
        // A drawer debounce timer that captured `staleGeneration` before the
        // purge, but whose setTimeout only fires well after the purge fully
        // resolved, must not recreate the purged cache.
        await persistChatSummaries('profile-purge', [summary('ghost')], undefined, staleGeneration);
        expect(write).toHaveBeenCalledTimes(writesBeforeStaleFlush);
        await expect(loadChatSummaryCache('profile-purge')).resolves.toMatchObject({
          entries: [],
        });

        // A fresh write (current generation) for the same profile id keeps
        // working normally after the purge.
        await persistChatSummaries('profile-purge', [summary('fresh')]);
        await expect(loadChatSummaryCache('profile-purge')).resolves.toMatchObject({
          entries: [{ summary: { id: 'fresh' } }],
        });
      } finally {
        restore();
      }
    });

    it('drops stale reconcile and delete-single-chat writes across the same barrier', async () => {
      const { restore } = mockFileSystem();
      try {
        await persistChatSummaries('profile-purge-2', [summary('one'), summary('two')]);
        const staleGeneration = getChatSummaryCacheGeneration('profile-purge-2');

        await deleteChatSummaryCache('profile-purge-2');

        // Both a stale authoritative reconcile and a stale single-chat
        // delete-persist must be no-ops once the barrier has moved on -
        // otherwise either could resurrect a file the purge just removed.
        await reconcilePersistedChatSummaries(
          'profile-purge-2',
          [summary('resurrected')],
          undefined,
          staleGeneration,
        );
        await deletePersistedChatSummary('profile-purge-2', 'one', undefined, staleGeneration);
        await expect(loadChatSummaryCache('profile-purge-2')).resolves.toMatchObject({
          entries: [],
        });
      } finally {
        restore();
      }
    });

    it('keeps same-identity writes and reads working with no intervening purge', async () => {
      const { restore } = mockFileSystem();
      try {
        const generation = getChatSummaryCacheGeneration('profile-stable');
        await persistChatSummaries('profile-stable', [summary('one')], undefined, generation);
        await persistChatSummaries(
          'profile-stable',
          [summary('two')],
          undefined,
          getChatSummaryCacheGeneration('profile-stable'),
        );
        await expect(loadChatSummaryCache('profile-stable')).resolves.toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({ summary: expect.objectContaining({ id: 'one' }) }),
            expect.objectContaining({ summary: expect.objectContaining({ id: 'two' }) }),
          ]),
        });
      } finally {
        restore();
      }
    });
  });
});
