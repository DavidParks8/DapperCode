import { DELETED_THREAD_TOMBSTONE_LIMIT, rememberDeletedThreadId } from './threadRuntimeMutations';

describe('deleted thread tombstones', () => {
  it('retains the newest bounded recovery window and refreshes repeated ids', () => {
    const tombstones = new Set<string>();
    for (let index = 0; index <= DELETED_THREAD_TOMBSTONE_LIMIT; index += 1) {
      rememberDeletedThreadId(tombstones, `thread-${String(index)}`);
    }

    expect(tombstones.size).toBe(DELETED_THREAD_TOMBSTONE_LIMIT);
    expect(tombstones.has('thread-0')).toBe(false);
    expect(tombstones.has(`thread-${String(DELETED_THREAD_TOMBSTONE_LIMIT)}`)).toBe(true);

    rememberDeletedThreadId(tombstones, 'thread-1');
    rememberDeletedThreadId(tombstones, 'newest');
    expect(tombstones.has('thread-1')).toBe(true);
    expect(tombstones.has('thread-2')).toBe(false);
    expect(tombstones.has('newest')).toBe(true);
  });
});
