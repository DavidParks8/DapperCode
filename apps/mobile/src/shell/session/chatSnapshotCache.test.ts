import { requireTestValue } from '@shared/testing/requireTestValue';
import type { Chat } from '@bridge/types/types';
import * as FileSystem from 'expo-file-system/legacy';
import {
  CHAT_SNAPSHOT_CACHE_MAX_BYTES,
  CHAT_SNAPSHOT_CACHE_MAX_ENTRIES,
  CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES,
  createEmptyChatSnapshotCache,
  deleteChatSnapshotCache,
  getChatSnapshotCacheGeneration,
  getChatSnapshotCachePath,
  loadChatSnapshotCache,
  parseChatSnapshotCache,
  saveChatSnapshotCache,
  updateChatSnapshotCache,
} from '@shell/session/chatSnapshotCache';

function chat(id: string, message = id): Chat {
  return {
    id,
    title: `Chat ${id}`,
    status: 'idle',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    statusUpdatedAt: '2026-07-01T00:00:00.000Z',
    lastMessagePreview: message,
    messages: [
      {
        id: `message-${id}`,
        role: 'assistant',
        content: message,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('chatSnapshotCache', () => {
  it('round trips exact-version snapshots for one profile', () => {
    const typedChat = chat('thread-1');
    requireTestValue(typedChat.messages[0], 'indexed test value').parts = [
      { type: 'text', text: 'A' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'text', text: 'B' },
      { type: 'resourceLink', uri: 'file:///linked.txt', name: 'linked.txt', size: 7 },
      {
        type: 'resource',
        resource: {
          uri: 'file:///embedded.txt',
          text: 'payload',
          mimeType: 'text/plain',
          metadata: { source: 'fixture' },
        },
      },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
    ];
    const updated = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'thread-1',
      typedChat,
      '2026-07-17T00:00:00.000Z',
    );

    expect(
      parseChatSnapshotCache(
        JSON.stringify(updated),
        'profile-a',
        Date.parse('2026-07-18T00:00:00.000Z'),
      ),
    ).toEqual(updated);
    expect(updated.entries[0]?.chat.messages[0]?.parts).toEqual(
      requireTestValue(typedChat.messages[0], 'indexed test value').parts,
    );
    expect(parseChatSnapshotCache(JSON.stringify(updated), 'profile-b').entries).toEqual([]);
  });

  it('rejects old schemas and malformed chats', () => {
    expect(
      parseChatSnapshotCache(
        JSON.stringify({ version: 0, profileId: 'profile-a', entries: [] }),
        'profile-a',
      ),
    ).toEqual(expect.objectContaining({ entries: [], selectedChatId: null }));
    expect(
      parseChatSnapshotCache(
        JSON.stringify({
          version: 1,
          profileId: 'profile-a',
          entries: [{ chat: { id: 'bad' }, cachedAt: 'bad', lastAccessedAt: 'bad' }],
        }),
        'profile-a',
      ).entries,
    ).toEqual([]);
    expect(parseChatSnapshotCache('{', 'profile-a').entries).toEqual([]);
    for (const root of [null, 'not-an-object', 42, []]) {
      expect(parseChatSnapshotCache(JSON.stringify(root), 'profile-a')).toEqual(
        expect.objectContaining({
          version: 1,
          profileId: 'profile-a',
          selectedChatId: null,
          entries: [],
        }),
      );
    }
  });

  it('bounds entries while retaining the selected snapshot', () => {
    let cache = createEmptyChatSnapshotCache('profile-a');
    for (let index = 0; index < CHAT_SNAPSHOT_CACHE_MAX_ENTRIES + 5; index += 1) {
      cache = updateChatSnapshotCache(
        cache,
        index === 0 ? 'thread-0' : cache.selectedChatId,
        chat(`thread-${String(index)}`),
        new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      );
    }

    expect(cache.entries).toHaveLength(CHAT_SNAPSHOT_CACHE_MAX_ENTRIES);
    expect(cache.entries.some((entry) => entry.chat.id === 'thread-0')).toBe(true);
  });

  it('drops expired snapshots', () => {
    const stored = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'thread-old',
      chat('thread-old'),
      '2026-01-01T00:00:00.000Z',
    );

    expect(
      parseChatSnapshotCache(
        JSON.stringify(stored),
        'profile-a',
        Date.parse('2026-07-17T00:00:00.000Z'),
      ).entries,
    ).toEqual([]);
  });

  it('uses only the profile id in the cache path', () => {
    const path = getChatSnapshotCachePath('profile-a', 'file:///documents/');
    expect(path).toBe('file:///documents/dappercode-chat-cache/profile-a/snapshots.json');
    expect(path).not.toContain('token');
    expect(path).not.toContain('http');
    expect(getChatSnapshotCachePath('', 'file:///documents/')).toBeNull();
    expect(getChatSnapshotCachePath('profile', null)).toBeNull();
    expect(getChatSnapshotCachePath('a/b', 'file:///documents/')).toContain('a%2Fb');
  });

  it('normalizes metadata, selection, and malformed entries', () => {
    const valid = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'one',
      chat('one'),
      '2026-07-17T00:00:00.000Z',
    );
    const parsed = parseChatSnapshotCache(
      JSON.stringify({
        ...valid,
        selectedChatId: 'missing',
        updatedAt: 'invalid',
        entries: [
          null,
          { chat: chat('bad-role'), cachedAt: 'bad', lastAccessedAt: 'bad' },
          ...valid.entries,
        ],
      }),
      'profile-a',
      Date.parse('2026-07-18T00:00:00.000Z'),
    );
    expect(parsed.selectedChatId).toBeNull();
    expect(parsed.updatedAt).toBe('2026-07-18T00:00:00.000Z');
    expect(parsed.entries).toHaveLength(1);
  });

  it('updates access time without replacing an existing snapshot', () => {
    const initial = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'one',
      chat('one'),
      '2026-07-17T00:00:00.000Z',
    );
    const updated = updateChatSnapshotCache(initial, 'one', null, '2026-07-18T00:00:00.000Z');
    expect(updated.entries[0]?.lastAccessedAt).toBe('2026-07-18T00:00:00.000Z');
    // Only the access time changes; the chat payload itself must not be
    // replaced by a fresh (deep-cloned) object when it wasn't modified.
    expect(updated.entries[0]?.chat).toBe(initial.entries[0]?.chat);
    expect(updateChatSnapshotCache(initial, ' missing ', null).selectedChatId).toBeNull();
  });

  it('rejects malformed chat fields and messages', () => {
    const base = chat('one');
    const invalidChats = [
      null,
      {},
      { ...base, id: '' },
      { ...base, title: 1 },
      { ...base, status: 1 },
      { ...base, createdAt: 1 },
      { ...base, updatedAt: 1 },
      { ...base, statusUpdatedAt: 1 },
      { ...base, lastMessagePreview: 1 },
      { ...base, messages: 'invalid' },
      { ...base, messages: [null] },
      { ...base, messages: [{ ...base.messages[0], role: 'tool' }] },
      { ...base, messages: [{ ...base.messages[0], content: 1 }] },
      { ...base, messages: [{ ...base.messages[0], createdAt: 1 }] },
    ];
    const raw = JSON.stringify({
      version: 1,
      profileId: 'profile-a',
      entries: invalidChats.map((value) => ({
        chat: value,
        cachedAt: '2026-07-17T00:00:00.000Z',
        lastAccessedAt: '2026-07-17T00:00:00.000Z',
      })),
    });
    expect(parseChatSnapshotCache(raw, 'profile-a').entries).toEqual([]);
  });

  it('skips snapshots that exceed the byte budget', () => {
    const huge = chat('huge', 'x'.repeat(CHAT_SNAPSHOT_CACHE_MAX_BYTES));
    const cache = updateChatSnapshotCache(createEmptyChatSnapshotCache('profile-a'), 'huge', huge);
    expect(cache.entries).toEqual([]);
    expect(cache.selectedChatId).toBeNull();
  });

  it('reuses chat object references for entries untouched by an update (perf regression)', () => {
    let cache = createEmptyChatSnapshotCache('profile-a');
    for (let index = 0; index < 5; index += 1) {
      cache = updateChatSnapshotCache(
        cache,
        null,
        chat(`thread-${String(index)}`),
        new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      );
    }

    const before = cache;
    const after = updateChatSnapshotCache(before, 'thread-0', null, '2026-07-02T00:00:00.000Z');

    expect(after.entries).toHaveLength(before.entries.length);
    for (const entry of after.entries) {
      const previous = before.entries.find((candidate) => candidate.chat.id === entry.chat.id);
      // A whole-cache deep clone (e.g. via JSON.parse(JSON.stringify(...)))
      // would give every entry a fresh chat object here even though only
      // one entry's access time actually changed.
      expect(entry.chat).toBe(previous?.chat);
    }
  });

  it('bounds entries without re-serializing the whole growing candidate on each insertion (perf regression)', () => {
    let cache = createEmptyChatSnapshotCache('profile-a');
    for (let index = 0; index < CHAT_SNAPSHOT_CACHE_MAX_ENTRIES; index += 1) {
      cache = updateChatSnapshotCache(
        cache,
        null,
        chat(`thread-${String(index)}`),
        new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      );
    }

    const stringifySpy = jest.spyOn(JSON, 'stringify');
    updateChatSnapshotCache(
      cache,
      null,
      chat('thread-final'),
      new Date(Date.UTC(2026, 6, 1, 1, 0)).toISOString(),
    );
    const maxEntriesPerStringifyCall = stringifySpy.mock.calls.reduce((max, [value]) => {
      const entries = (value as { entries?: unknown[] } | null | undefined)?.entries;
      return Array.isArray(entries) ? Math.max(max, entries.length) : max;
    }, 0);
    stringifySpy.mockRestore();

    // An O(n^2) bounding pass re-stringifies the whole (growing) candidate
    // entries array once per accepted entry, so this would climb toward
    // CHAT_SNAPSHOT_CACHE_MAX_ENTRIES here. Serializing one entry at a time
    // should never need more than a single entry per call.
    expect(maxEntriesPerStringifyCall).toBeLessThanOrEqual(1);
  });

  it('drops oversized inline image/audio data instead of evicting the whole chat', () => {
    const withMedia = chat('with-media');
    const oversizedImageData = 'i'.repeat(CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES + 1);
    const oversizedAudioData = 'a'.repeat(CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES + 1);
    requireTestValue(withMedia.messages[0], 'indexed test value').parts = [
      { type: 'text', text: 'before' },
      { type: 'image', data: oversizedImageData, mimeType: 'image/png', uri: 'file:///cached.png' },
      { type: 'audio', data: oversizedAudioData, mimeType: 'audio/wav' },
    ];
    const originalParts = requireTestValue(
      requireTestValue(withMedia.messages[0], 'indexed test value').parts,
      'original message parts',
    ).map((part) => ({ ...part }));

    const cache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'with-media',
      withMedia,
    );

    expect(cache.entries).toHaveLength(1);
    const [textPart, imagePart, audioPart] = requireTestValue(
      requireTestValue(
        requireTestValue(cache.entries[0], 'indexed test value').chat.messages[0],
        'indexed test value',
      ).parts,
      'cached message parts',
    );
    expect(textPart).toEqual({ type: 'text', text: 'before' });
    expect(imagePart).toEqual({ type: 'image', mimeType: 'image/png', uri: 'file:///cached.png' });
    expect(audioPart).toEqual({ type: 'audio', mimeType: 'audio/wav' });

    // The live/in-memory chat object handed to the cache must be left
    // untouched: the active session keeps its full-fidelity payloads.
    expect(requireTestValue(withMedia.messages[0], 'indexed test value').parts).toEqual(
      originalParts,
    );
  });

  it('keeps inline image/audio data at or under the threshold untouched', () => {
    const withSmallImage = chat('with-small-image');
    requireTestValue(withSmallImage.messages[0], 'indexed test value').parts = [
      {
        type: 'image',
        data: 'i'.repeat(CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES),
        mimeType: 'image/png',
      },
    ];

    const cache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'with-small-image',
      withSmallImage,
    );

    expect(cache.entries[0]?.chat.messages[0]?.parts).toEqual(
      requireTestValue(withSmallImage.messages[0], 'indexed test value').parts,
    );
  });

  it('drops oversized inline resource blobs while keeping resource metadata', () => {
    const withResource = chat('with-resource');
    requireTestValue(withResource.messages[0], 'indexed test value').parts = [
      {
        type: 'resource',
        resource: {
          uri: 'file:///big.bin',
          mimeType: 'application/octet-stream',
          blob: 'b'.repeat(CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES + 1),
        },
      },
    ];

    const cache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'with-resource',
      withResource,
    );

    expect(cache.entries[0]?.chat.messages[0]?.parts).toEqual([
      {
        type: 'resource',
        resource: { uri: 'file:///big.bin', mimeType: 'application/octet-stream' },
      },
    ]);
  });

  it('drops oversized structured tool output while keeping the tool message', () => {
    const withTool = chat('with-tool');
    withTool.messages = [
      {
        id: 'tool-1',
        role: 'tool',
        toolCallId: 'tool-1',
        content: 'ran a command',
        createdAt: '2026-07-01T00:00:00.000Z',
        toolMeta: {
          toolCallId: 'tool-1',
          kind: 'execute',
          status: 'completed',
          title: 'Run command',
          content: [{ text: 'x'.repeat(CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES + 1) }],
          locations: [{ path: 'y'.repeat(CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES + 1) }],
        },
      },
    ];
    withTool.lastMessagePreview = 'ran a command';

    const cache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'with-tool',
      withTool,
    );

    expect(cache.entries).toHaveLength(1);
    const toolMeta = cache.entries[0]?.chat.messages[0]?.toolMeta;
    expect(toolMeta).toMatchObject({ toolCallId: 'tool-1', kind: 'execute', status: 'completed' });
    expect(toolMeta?.content).toBeUndefined();
    expect(toolMeta?.locations).toBeUndefined();
  });

  it('does not let in-flight, queued, or delayed stale saves resurrect a purged snapshot', async () => {
    const originalDirectory = FileSystem.documentDirectory;
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: 'file:///documents/',
    });
    const profileId = 'profile-purge';
    const path = getChatSnapshotCachePath(profileId)!;
    const files = new Map<string, string>([[path, 'existing snapshot']]);
    const directoryStarted = deferred<void>();
    const directoryGate = deferred<void>();
    const deletionGate = deferred<void>();
    const mkdir = jest.spyOn(FileSystem, 'makeDirectoryAsync').mockImplementation(async () => {
      directoryStarted.resolve();
      await directoryGate.promise;
    });
    const write = jest
      .spyOn(FileSystem, 'writeAsStringAsync')
      .mockImplementation(async (filePath, raw) => {
        files.set(filePath, raw);
      });
    const remove = jest.spyOn(FileSystem, 'deleteAsync').mockImplementation(async (filePath) => {
      await deletionGate.promise;
      files.delete(filePath);
    });
    const staleGeneration = getChatSnapshotCacheGeneration(profileId);
    const staleCache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache(profileId),
      'stale',
      chat('stale'),
    );

    try {
      const inFlight = saveChatSnapshotCache(staleCache, staleGeneration);
      await directoryStarted.promise;
      const queued = saveChatSnapshotCache(staleCache, staleGeneration);
      const purge = deleteChatSnapshotCache(profileId);

      // With the old independent deletion, this completes the delete while
      // the first save is still waiting on its directory operation. Releasing
      // that save then re-created snapshots.json (and the queued save did too).
      deletionGate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      directoryGate.resolve();
      await Promise.all([inFlight, queued, purge]);

      expect(files.has(path)).toBe(false);
      expect(write).not.toHaveBeenCalled();

      // A debounce callback can invoke save only after the purge completes,
      // so it must carry the generation captured when it was scheduled.
      await saveChatSnapshotCache(staleCache, staleGeneration);
      expect(files.has(path)).toBe(false);
      expect(write).not.toHaveBeenCalled();

      const freshCache = updateChatSnapshotCache(
        createEmptyChatSnapshotCache(profileId),
        'fresh',
        chat('fresh'),
      );
      await saveChatSnapshotCache(freshCache);
      expect(JSON.parse(files.get(path) ?? '{}')).toMatchObject({
        selectedChatId: 'fresh',
        entries: [expect.objectContaining({ chat: expect.objectContaining({ id: 'fresh' }) })],
      });
    } finally {
      Object.defineProperty(FileSystem, 'documentDirectory', {
        configurable: true,
        value: originalDirectory,
      });
      mkdir.mockRestore();
      write.mockRestore();
      remove.mockRestore();
    }
  });

  it('loads, saves, serializes writes, and deletes snapshots', async () => {
    const originalDirectory = FileSystem.documentDirectory;
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: 'file:///documents/',
    });
    const read = jest.spyOn(FileSystem, 'readAsStringAsync');
    const mkdir = jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
    const write = jest.spyOn(FileSystem, 'writeAsStringAsync').mockResolvedValue(undefined);
    const remove = jest.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);
    const cache = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'one',
      chat('one'),
    );
    read.mockResolvedValueOnce(JSON.stringify(cache));
    await expect(loadChatSnapshotCache('profile-a')).resolves.toMatchObject({
      selectedChatId: 'one',
    });
    read.mockRejectedValueOnce(new Error('missing'));
    await expect(loadChatSnapshotCache('profile-a')).resolves.toMatchObject({ entries: [] });
    await Promise.all([saveChatSnapshotCache(cache), saveChatSnapshotCache(cache)]);
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    await deleteChatSnapshotCache('profile-a');
    expect(remove).toHaveBeenCalledWith(expect.stringContaining('profile-a'), { idempotent: true });
    remove.mockRejectedValueOnce(new Error('missing'));
    await expect(deleteChatSnapshotCache('profile-a')).resolves.toBeUndefined();
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: originalDirectory,
    });
  });
});
