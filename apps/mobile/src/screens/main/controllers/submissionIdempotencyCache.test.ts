jest.mock('../mainScreenHelpers', () => ({
  ...jest.requireActual('../mainScreenHelpers'),
  getChatSubmissionIdempotencyPath: jest.fn(
    (profileId: string) => `/idempotency-${profileId}.json`,
  ),
}));

import {
  SUBMISSION_IDEMPOTENCY_LIMIT,
  SUBMISSION_IDEMPOTENCY_TTL_MS,
  SubmissionIdempotencyCache,
  type SubmissionIdempotencyStorage,
  hashSubmissionRequest,
  parseSubmissionIdempotencyEntries,
  pruneSubmissionIdempotencyEntries,
  serializeSubmissionIdempotencyEntries,
} from './submissionIdempotencyCache';

function memoryStorage(
  initial: Record<string, string> = {},
): SubmissionIdempotencyStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: jest.fn(async (path: string) => {
      const value = values.get(path);
      if (value === undefined) {
        throw new Error('missing');
      }
      return value;
    }),
    write: jest.fn(async (path: string, value: string) => {
      values.set(path, value);
    }),
    exists: jest.fn(async (path: string) => values.has(path)),
  };
}

describe('hashSubmissionRequest', () => {
  it('is stable for identical draft and attachment content', () => {
    const attachments = { mentions: ['/a.ts'], localImages: ['/a.png'] };
    expect(hashSubmissionRequest('hello world', attachments)).toBe(
      hashSubmissionRequest('hello world', { mentions: ['/a.ts'], localImages: ['/a.png'] }),
    );
  });

  it('changes when the draft text changes', () => {
    const attachments = { mentions: [], localImages: [] };
    expect(hashSubmissionRequest('hello', attachments)).not.toBe(
      hashSubmissionRequest('hello!', attachments),
    );
  });

  it('changes when attachments change', () => {
    expect(hashSubmissionRequest('hello', { mentions: ['/a'], localImages: [] })).not.toBe(
      hashSubmissionRequest('hello', { mentions: ['/b'], localImages: [] }),
    );
  });

  it('never needs to look like the original prompt — it is a fixed-width opaque digest', () => {
    const hash = hashSubmissionRequest('some very sensitive prompt content', {
      mentions: [],
      localImages: [],
    });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('sensitive');
  });
});

describe('pruneSubmissionIdempotencyEntries', () => {
  it('drops entries older than the TTL', () => {
    const now = 1_000_000;
    const entries = {
      fresh: { submissionId: 'a', updatedAt: now - 10 },
      stale: { submissionId: 'b', updatedAt: now - SUBMISSION_IDEMPOTENCY_TTL_MS - 1 },
    };
    expect(pruneSubmissionIdempotencyEntries(entries, now)).toEqual({
      fresh: { submissionId: 'a', updatedAt: now - 10 },
    });
  });

  it('bounds the entry count, evicting the oldest first', () => {
    const now = 1_000_000;
    const entries: Record<string, { submissionId: string; updatedAt: number }> = {};
    for (let index = 0; index < SUBMISSION_IDEMPOTENCY_LIMIT + 5; index += 1) {
      entries[`key-${index}`] = { submissionId: `id-${index}`, updatedAt: now + index };
    }
    const pruned = pruneSubmissionIdempotencyEntries(
      entries,
      now + SUBMISSION_IDEMPOTENCY_LIMIT + 5,
    );
    expect(Object.keys(pruned)).toHaveLength(SUBMISSION_IDEMPOTENCY_LIMIT);
    expect(pruned['key-0']).toBeUndefined();
    expect(pruned['key-4']).toBeUndefined();
    expect(pruned[`key-${SUBMISSION_IDEMPOTENCY_LIMIT + 4}`]).toBeDefined();
  });
});

describe('parseSubmissionIdempotencyEntries / serializeSubmissionIdempotencyEntries', () => {
  it('round-trips through serialize/parse', () => {
    const now = 1_000_000;
    const entries = { key: { submissionId: 'id-1', updatedAt: now } };
    const raw = serializeSubmissionIdempotencyEntries(entries);
    expect(parseSubmissionIdempotencyEntries(raw, now)).toEqual(entries);
  });

  it('ignores malformed, mismatched-version, or non-object payloads', () => {
    expect(parseSubmissionIdempotencyEntries('not json', Date.now())).toEqual({});
    expect(
      parseSubmissionIdempotencyEntries(JSON.stringify({ version: 999, entries: {} }), Date.now()),
    ).toEqual({});
    expect(
      parseSubmissionIdempotencyEntries(
        JSON.stringify({ version: 1, entries: { key: { submissionId: 42, updatedAt: 'x' } } }),
        Date.now(),
      ),
    ).toEqual({});
  });

  it('never round-trips prompt content — only submissionId and a timestamp are stored', () => {
    const raw = serializeSubmissionIdempotencyEntries({
      key: { submissionId: 'id-1', updatedAt: 1 },
    });
    expect(raw).not.toContain('draft');
    expect(JSON.parse(raw)).toEqual({
      version: expect.any(Number),
      entries: { key: { submissionId: 'id-1', updatedAt: 1 } },
    });
  });
});

describe('SubmissionIdempotencyCache', () => {
  it('returns null for a scope/hash with no persisted entry', async () => {
    const cache = new SubmissionIdempotencyCache({
      profileId: 'profile-a',
      storage: memoryStorage(),
    });
    await cache.load();
    expect(cache.lookup('scope', 'hash')).toBeNull();
  });

  it('persists a recorded entry so a later cache instance (simulated restart) can look it up', async () => {
    const storage = memoryStorage();
    const first = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await first.load();
    first.record('scope', 'hash', 'submission-1');
    await first.flush();

    const restarted = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await restarted.load();
    expect(restarted.lookup('scope', 'hash')).toBe('submission-1');
  });

  it('never writes draft content to storage, only the submission id and timestamp', async () => {
    const storage = memoryStorage();
    const cache = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await cache.load();
    cache.record('scope', 'hash', 'submission-1');
    await cache.flush();

    const raw = storage.values.get('/idempotency-profile-a.json');
    expect(raw).toBeDefined();
    expect(raw).not.toContain('draft');
    expect(raw).not.toContain('mentions');
  });

  it('clears an entry on successful settlement', async () => {
    const storage = memoryStorage();
    const cache = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await cache.load();
    cache.record('scope', 'hash', 'submission-1');
    cache.clear('scope', 'hash');
    await cache.flush();

    expect(cache.lookup('scope', 'hash')).toBeNull();
    const restarted = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await restarted.load();
    expect(restarted.lookup('scope', 'hash')).toBeNull();
  });

  it('expires a persisted entry once its TTL has elapsed', async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const cache = new SubmissionIdempotencyCache({
      profileId: 'profile-a',
      storage,
      now: () => now,
    });
    await cache.load();
    cache.record('scope', 'hash', 'submission-1');
    await cache.flush();

    now += SUBMISSION_IDEMPOTENCY_TTL_MS + 1;
    expect(cache.lookup('scope', 'hash')).toBeNull();

    const restarted = new SubmissionIdempotencyCache({
      profileId: 'profile-a',
      storage,
      now: () => now,
    });
    await restarted.load();
    expect(restarted.lookup('scope', 'hash')).toBeNull();
  });

  it('bounds the number of retained entries per profile', async () => {
    const storage = memoryStorage();
    const cache = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage, limit: 2 });
    await cache.load();
    cache.record('scope', 'hash-1', 'submission-1');
    cache.record('scope', 'hash-2', 'submission-2');
    cache.record('scope', 'hash-3', 'submission-3');
    await cache.flush();

    expect(cache.lookup('scope', 'hash-1')).toBeNull();
    expect(cache.lookup('scope', 'hash-2')).toBe('submission-2');
    expect(cache.lookup('scope', 'hash-3')).toBe('submission-3');
  });

  it('scopes entries by the caller-provided scope key so profiles/threads never collide', async () => {
    const storage = memoryStorage();
    const cache = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await cache.load();
    cache.record('scope-a', 'hash', 'submission-a');
    cache.record('scope-b', 'hash', 'submission-b');
    await cache.flush();

    expect(cache.lookup('scope-a', 'hash')).toBe('submission-a');
    expect(cache.lookup('scope-b', 'hash')).toBe('submission-b');
  });

  it('does not write to storage at construction or load time — only in response to record/clear', async () => {
    const storage = memoryStorage({
      '/idempotency-profile-a.json': serializeSubmissionIdempotencyEntries({}),
    });
    const cache = new SubmissionIdempotencyCache({ profileId: 'profile-a', storage });
    await cache.load();
    expect(storage.write).not.toHaveBeenCalled();
    cache.lookup('scope', 'hash');
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('reports a persistence error without throwing when the write fails', async () => {
    const storage = memoryStorage();
    (storage.write as jest.Mock).mockRejectedValue(new Error('disk full'));
    const onPersistenceError = jest.fn();
    const cache = new SubmissionIdempotencyCache({
      profileId: 'profile-a',
      storage,
      onPersistenceError,
    });
    await cache.load();
    cache.record('scope', 'hash', 'submission-1');
    await cache.flush();

    expect(onPersistenceError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ProfilePersistenceError', operation: 'write' }),
    );
  });
});
