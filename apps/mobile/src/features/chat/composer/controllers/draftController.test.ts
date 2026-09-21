import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../../helpers/helpers', () => ({
  ...jest.requireActual('../../helpers/helpers'),
  getChatDraftsPath: jest.fn((profileId: string) => `/drafts-${profileId}.json`),
}));

import {
  type DraftController,
  type DraftStorage,
  type DraftRecovery,
  serializeDraftEntries,
  updateDraftEntries,
  useDraftController,
} from './draftController';

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & {
  values: Map<string, string>;
} {
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

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('draftController', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    jest.useRealTimers();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('updates one scope without overwriting another', () => {
    expect(updateDraftEntries({ first: 'keep' }, 'second', 'new draft')).toEqual({
      first: 'keep',
      second: 'new draft',
    });
  });

  it('removes blank drafts and serializes the current version', () => {
    const entries = updateDraftEntries({ first: 'draft' }, 'first', '  ');
    expect(entries).toEqual({});
    expect(JSON.parse(serializeDraftEntries(entries))).toEqual({ version: 2, entries: {} });
  });

  it('restores interrupted text and saved follow-up drafts without losing other scopes', async () => {
    const targetScopeKey = JSON.stringify(['profile', null]);
    const sourceScopeKey = JSON.stringify(['profile', 'pending-original']);
    const otherScopeKey = JSON.stringify(['profile', 'other']);
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({
        [sourceScopeKey]: 'Follow-up draft',
        [otherScopeKey]: 'Keep this other draft',
      }),
    });
    const recovery: DraftRecovery = {
      draft: 'Interrupted message',
      sourceScopeKey,
      targetScopeKey,
      onConsumed: jest.fn(),
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, undefined, 'ios', recovery);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.restoring).toBe(false);
    expect(current.draft).toBe('Interrupted message\n\nFollow-up draft');
    expect(JSON.parse(storage.values.get('/drafts-profile.json') ?? '{}').entries).toEqual({
      [targetScopeKey]: current.draft,
      [otherScopeKey]: 'Keep this other draft',
    });
    expect(recovery.onConsumed).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.draft).toBe('Interrupted message\n\nFollow-up draft');
    act(() => tree.unmount());
  });

  it('retains an unchanged recovered submission until the user edits or submits it', async () => {
    const storage = memoryStorage();
    const onConsumed = jest.fn();
    const recovery: DraftRecovery = {
      draft: 'Interrupted message',
      sourceScopeKey: JSON.stringify(['profile', 'pending-original']),
      targetScopeKey: JSON.stringify(['profile', null]),
      onConsumed,
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, undefined, 'ios', recovery);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.draft).toBe(recovery.draft);
    expect(onConsumed).not.toHaveBeenCalled();
    act(() => current.setDraft(recovery.draft));
    expect(onConsumed).not.toHaveBeenCalled();
    await act(async () => {
      current.editDraft('Edited message');
      await flushMicrotasks();
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(current.draft).toBe('Edited message');
    act(() => tree.unmount());
  });

  it('keeps linked recovery while restoring the real-thread draft as the source of truth', async () => {
    jest.useFakeTimers();
    const targetScopeKey = JSON.stringify(['profile', 'thread-created']);
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({
        [targetScopeKey]: '  Edited after create  ',
      }),
    });
    const onConsumed = jest.fn();
    const recovery: DraftRecovery = {
      draft: '  Original before create  ',
      sourceScopeKey: JSON.stringify(['profile', 'pending-original']),
      targetScopeKey,
      consumeOnEdit: false,
      savedDraftReplacesOriginal: true,
      onConsumed,
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController(
        'profile',
        'thread-created',
        storage,
        undefined,
        'ios',
        recovery,
      );
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.draft).toBe('  Edited after create  ');
    expect(current.restoring).toBe(false);
    expect(onConsumed).not.toHaveBeenCalled();
    await act(async () => {
      current.editDraft('Whitespace preserved  ');
      await flushMicrotasks();
    });
    await act(async () => {
      jest.advanceTimersByTime(180);
      await flushMicrotasks();
    });
    expect(onConsumed).not.toHaveBeenCalled();
    expect(storage.values.get('/drafts-profile.json')).toContain('Whitespace preserved  ');
    act(() => tree.unmount());

    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    await act(async () => {
      current.editDraft('');
      await flushMicrotasks();
    });
    await act(async () => {
      jest.advanceTimersByTime(180);
      await flushMicrotasks();
    });
    act(() => tree.unmount());
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.draft).toBe('');
    expect(onConsumed).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('consumes recovery only after the latest rapid edit is persisted', async () => {
    const writes = [deferred<void>(), deferred<void>()];
    const storage = memoryStorage();
    const onConsumed = jest.fn();
    const recovery: DraftRecovery = {
      draft: 'Original',
      sourceScopeKey: JSON.stringify(['profile', 'pending-original']),
      targetScopeKey: JSON.stringify(['profile', null]),
      onConsumed,
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, undefined, 'ios', recovery);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    jest
      .mocked(storage.write)
      .mockClear()
      .mockImplementationOnce(async (path, value) => {
        await writes[0]!.promise;
        storage.values.set(path, value);
      })
      .mockImplementationOnce(async (path, value) => {
        await writes[1]!.promise;
        storage.values.set(path, value);
      });
    act(() => current.editDraft('First edit'));
    act(() => current.editDraft('Latest edit'));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(current.restoring).toBe(true);
    expect(storage.write).toHaveBeenCalledTimes(1);
    await act(async () => {
      writes[0]!.resolve();
      await flushMicrotasks();
    });
    expect(onConsumed).not.toHaveBeenCalled();
    expect(current.restoring).toBe(true);
    expect(storage.write).toHaveBeenCalledTimes(2);
    await act(async () => {
      writes[1]!.resolve();
      await flushMicrotasks();
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(current.restoring).toBe(false);
    expect(storage.values.get('/drafts-profile.json')).not.toContain('First edit');
    act(() => tree.unmount());
  });

  it('consumes recovery when a scheduled retry persists an edit after the first write fails', async () => {
    jest.useFakeTimers();
    const storage = memoryStorage();
    const onConsumed = jest.fn();
    const recovery: DraftRecovery = {
      draft: 'Original',
      sourceScopeKey: JSON.stringify(['profile', 'pending-original']),
      targetScopeKey: JSON.stringify(['profile', null]),
      onConsumed,
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, undefined, 'ios', recovery);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    jest
      .mocked(storage.write)
      .mockClear()
      .mockRejectedValueOnce(new Error('first write failure'))
      .mockRejectedValueOnce(new Error('retry write failure'))
      .mockImplementation(async (path, value) => {
        storage.values.set(path, value);
      });
    await act(async () => {
      current.editDraft('Edited');
      await flushMicrotasks();
    });
    expect(onConsumed).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(onConsumed).not.toHaveBeenCalled();
    expect(current.restoring).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(storage.values.get('/drafts-profile.json')).toContain('Edited');
    act(() => tree.unmount());
  });

  it('retries a failed initial recovered-draft merge instead of restoring forever', async () => {
    jest.useFakeTimers();
    const targetScopeKey = JSON.stringify(['profile', null]);
    const sourceScopeKey = JSON.stringify(['profile', 'pending-original']);
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({
        [sourceScopeKey]: 'Saved follow-up',
      }),
    });
    jest
      .mocked(storage.write)
      .mockRejectedValueOnce(new Error('initial merge write failed'))
      .mockImplementation(async (path, value) => {
        storage.values.set(path, value);
      });
    const onConsumed = jest.fn();
    const recovery: DraftRecovery = {
      draft: 'Interrupted message',
      sourceScopeKey,
      targetScopeKey,
      onConsumed,
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, undefined, 'ios', recovery);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.restoring).toBe(true);
    expect(onConsumed).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(current.restoring).toBe(false);
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(storage.values.get('/drafts-profile.json')).toContain(
      'Interrupted message\\n\\nSaved follow-up',
    );
    act(() => tree.unmount());
  });

  it('retries mandatory recovery consumption after the draft write succeeds', async () => {
    jest.useFakeTimers();
    const targetScopeKey = JSON.stringify(['profile', null]);
    const sourceScopeKey = JSON.stringify(['profile', 'pending-original']);
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({
        [sourceScopeKey]: 'Saved follow-up',
      }),
    });
    const onConsumed = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('cache write failed'))
      .mockResolvedValue(undefined);
    const recovery: DraftRecovery = {
      draft: 'Interrupted message',
      sourceScopeKey,
      targetScopeKey,
      onConsumed,
    };
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, undefined, 'ios', recovery);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    expect(current.restoring).toBe(true);
    expect(onConsumed).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(onConsumed).toHaveBeenCalledTimes(2);
    expect(current.restoring).toBe(false);
    act(() => tree.unmount());
  });

  it('does not persist the programmatic send clear until the submission is accepted', async () => {
    jest.useFakeTimers();
    const scopeKey = JSON.stringify(['profile', 'thread']);
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({ [scopeKey]: 'Recover me' }),
    });
    let current!: DraftController;
    function Probe() {
      current = useDraftController('profile', 'thread', storage);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
      await flushMicrotasks();
    });
    const submission = current.snapshot();
    let clearedRevision: number | null = null;
    act(() => {
      clearedRevision = current.clearForSubmission(submission);
    });
    await act(async () => {
      jest.advanceTimersByTime(180);
      await flushMicrotasks();
    });
    expect(storage.values.get('/drafts-profile.json')).toContain('Recover me');

    act(() =>
      current.commitSubmissionClear({
        draft: submission.value,
        clearedDraft: submission.value,
        clearedDraftEntries: [{ scopeKey: submission.scopeKey, draft: submission.value }],
        clearedRevision,
        clearedScopeKey: submission.scopeKey,
      }),
    );
    await act(async () => {
      jest.advanceTimersByTime(180);
      await flushMicrotasks();
    });
    expect(JSON.parse(storage.values.get('/drafts-profile.json') ?? '{}').entries).toEqual({});
    act(() => tree.unmount());
  });

  it('finishes recovery consumption when navigation replaces the recovery object', async () => {
    const storage = memoryStorage();
    const onConsumed = jest.fn();
    const recovery: DraftRecovery = {
      draft: 'Recovered',
      sourceScopeKey: JSON.stringify(['profile', 'pending-original']),
      targetScopeKey: JSON.stringify(['profile', null]),
      onConsumed,
    };
    let current!: DraftController;
    function Probe({ value }: { value: DraftRecovery }) {
      current = useDraftController('profile', null, storage, undefined, 'ios', value);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe, { value: recovery }));
      await flushMicrotasks();
    });
    const write = deferred<void>();
    jest.mocked(storage.write).mockImplementationOnce(() => write.promise);
    act(() => current.editDraft('Edited'));
    act(() => tree.update(React.createElement(Probe, { value: { ...recovery } })));
    await act(async () => {
      write.resolve();
      await flushMicrotasks();
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(current.restoring).toBe(false);
    act(() => tree.unmount());
  });

  it('loads, updates, debounces, switches scope, and flushes on unmount', async () => {
    jest.useFakeTimers();
    const firstKey = JSON.stringify(['profile', 'thread-1']);
    const secondKey = JSON.stringify(['profile', 'thread-2']);
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({
        [firstKey]: 'first',
        [secondKey]: 'second',
      }),
    });
    let current: DraftController;
    function Probe({ chatId }: { chatId: string }) {
      current = useDraftController('profile', chatId, storage);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe, { chatId: 'thread-1' }));
    });
    expect(current!.draft).toBe('first');
    act(() => current!.setDraft((value) => `${value}!`));
    expect(current!.snapshot()).toMatchObject({ scopeKey: firstKey, value: 'first!' });
    await act(async () => {
      jest.advanceTimersByTime(180);
      await Promise.resolve();
    });
    expect(storage.values.get('/drafts-profile.json')).toContain('first!');

    await act(async () => {
      tree!.update(React.createElement(Probe, { chatId: 'thread-2' }));
    });
    expect(current!.draft).toBe('second');
    act(() => current!.clearDraft());
    act(() => tree!.unmount());
  });

  it('keeps text typed while hydration is still in flight instead of letting the delayed read overwrite it', async () => {
    jest.useFakeTimers();
    const firstKey = JSON.stringify(['profile', 'thread-1']);
    const base = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({ [firstKey]: 'stored draft' }),
    });
    let releaseRead: (() => void) | null = null;
    const gatedRead = jest.fn((path: string) => {
      if (path === '/drafts-profile.json') {
        return new Promise<string>((resolve, reject) => {
          releaseRead = () => {
            base.read(path).then(resolve, reject);
          };
        });
      }
      return base.read(path);
    });
    const storage: DraftStorage & { values: Map<string, string> } = {
      ...base,
      read: gatedRead,
    };

    let current: DraftController;
    function Probe({ chatId }: { chatId: string }) {
      current = useDraftController('profile', chatId, storage);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe, { chatId: 'thread-1' }));
      await flushMicrotasks();
    });
    expect(releaseRead).not.toBeNull();

    // The persisted-draft read for this scope is still pending. Typing now must not be lost
    // once that delayed read finally resolves.
    act(() => current!.setDraft('typed while loading'));
    expect(current!.draft).toBe('typed while loading');

    await act(async () => {
      releaseRead?.();
      await flushMicrotasks();
    });

    // The stale persisted value ("stored draft") must never clobber the newer edit.
    expect(current!.draft).toBe('typed while loading');

    await act(async () => {
      jest.advanceTimersByTime(180);
      await flushMicrotasks();
    });
    expect(storage.values.get('/drafts-profile.json')).toContain('typed while loading');
    act(() => tree!.unmount());
  });

  it('protects a draft typed into a new chat while the prior scope hydration read is still pending', async () => {
    jest.useFakeTimers();
    const firstKey = JSON.stringify(['profile', 'thread-1']);
    const secondKey = JSON.stringify(['profile', 'thread-2']);
    const base = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({ [firstKey]: 'thread one stored' }),
    });
    let releaseRead: (() => void) | null = null;
    const gatedRead = jest.fn((path: string) => {
      if (path === '/drafts-profile.json') {
        return new Promise<string>((resolve, reject) => {
          releaseRead = () => {
            base.read(path).then(resolve, reject);
          };
        });
      }
      return base.read(path);
    });
    const storage: DraftStorage & { values: Map<string, string> } = {
      ...base,
      read: gatedRead,
    };

    let current: DraftController;
    function Probe({ chatId }: { chatId: string }) {
      current = useDraftController('profile', chatId, storage);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe, { chatId: 'thread-1' }));
      await flushMicrotasks();
    });
    expect(releaseRead).not.toBeNull();

    // Navigate to a different chat, then type into it, before the pending hydration read resolves.
    act(() => {
      tree!.update(React.createElement(Probe, { chatId: 'thread-2' }));
    });
    act(() => current!.setDraft('typed into thread two'));
    expect(current!.draft).toBe('typed into thread two');

    await act(async () => {
      releaseRead?.();
      await flushMicrotasks();
    });

    // The now-resolved read must not replace the edit made after navigating away.
    expect(current!.draft).toBe('typed into thread two');

    await act(async () => {
      jest.advanceTimersByTime(180);
      await flushMicrotasks();
    });
    const persisted = JSON.parse(storage.values.get('/drafts-profile.json')!).entries as Record<
      string,
      string
    >;
    expect(persisted[secondKey]).toBe('typed into thread two');
    expect(persisted[firstKey]).toBe('thread one stored');
    act(() => tree!.unmount());
  });

  it('exposes and reports an actionable typed write failure', async () => {
    jest.useFakeTimers();
    const storage = memoryStorage({
      '/drafts-profile.json': serializeDraftEntries({}),
    });
    (storage.write as jest.Mock).mockRejectedValue(new Error('disk full'));
    const report = jest.fn();
    let current: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage, report);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
    });
    act(() => current!.setDraft('draft'));
    await act(async () => {
      jest.advanceTimersByTime(180);
      await Promise.resolve();
    });

    expect(current!.persistenceError).toMatchObject({
      name: 'ProfilePersistenceError',
      operation: 'write',
      resource: 'chat drafts',
    });
    expect(report).toHaveBeenCalledWith(current!.persistenceError);
    expect(current!.persistenceError?.message).toContain('available device storage');
    act(() => tree!.unmount());
  });

  it('persists drafts to profile-scoped browser storage', async () => {
    jest.useFakeTimers();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn((key: string) => values.get(key) ?? null),
        setItem: jest.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    let current: DraftController;
    function Probe() {
      current = useDraftController('web/profile', null, undefined, undefined, 'web');
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe));
    });
    act(() => current!.setDraft('web draft'));
    await act(async () => {
      jest.advanceTimersByTime(180);
      await Promise.resolve();
    });

    const raw = values.get('dappercode.main-screen.profile.web%2Fprofile.drafts.v2');
    expect(raw).toContain('web draft');
    act(() => tree!.unmount());
  });
});
