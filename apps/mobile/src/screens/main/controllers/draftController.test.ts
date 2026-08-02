import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../mainScreenHelpers', () => ({
  ...jest.requireActual('../mainScreenHelpers'),
  getChatDraftsPath: jest.fn((profileId: string) => `/drafts-${profileId}.json`),
  getLegacyChatDraftsPath: jest.fn(() => '/drafts.json'),
  getPersistenceMigrationMarkerPath: jest.fn(
    (resource: string, profileId?: string) =>
      `/migration-${resource}-${profileId ?? 'global'}.json`,
  ),
}));

import {
  type DraftController,
  type DraftStorage,
  migrateLegacyDraftEntries,
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

  it('partitions legacy drafts by profile', () => {
    const firstKey = JSON.stringify(['first', 'thread']);
    const secondKey = JSON.stringify(['second', 'thread']);
    const migrated = migrateLegacyDraftEntries(
      serializeDraftEntries({ [firstKey]: 'first draft', [secondKey]: 'second draft' }),
      'first',
    );
    expect(JSON.parse(migrated).entries).toEqual({ [firstKey]: 'first draft' });
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

  it('restores each profile legacy draft without copying another profile into its file', async () => {
    const firstKey = JSON.stringify(['first', 'thread']);
    const secondKey = JSON.stringify(['second', 'thread']);
    const storage = memoryStorage({
      '/drafts.json': serializeDraftEntries({
        [firstKey]: 'first legacy',
        [secondKey]: 'second legacy',
      }),
    });
    let current: DraftController;
    function Probe({ profileId }: { profileId: string }) {
      current = useDraftController(profileId, 'thread', storage);
      return null;
    }

    let tree: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Probe, { profileId: 'first' }));
    });
    expect(current!.draft).toBe('first legacy');
    act(() => tree!.unmount());

    await act(async () => {
      tree = renderer.create(React.createElement(Probe, { profileId: 'second' }));
    });
    expect(current!.draft).toBe('second legacy');
    expect(JSON.parse(storage.values.get('/drafts-first.json')!).entries).toEqual({
      [firstKey]: 'first legacy',
    });
    expect(JSON.parse(storage.values.get('/drafts-second.json')!).entries).toEqual({
      [secondKey]: 'second legacy',
    });
    expect(storage.values.get('/drafts.json')).toContain('first legacy');
    act(() => tree!.unmount());
  });

  it('exposes and reports an actionable typed write failure', async () => {
    jest.useFakeTimers();
    const marker = JSON.stringify({ version: 1, profileId: 'profile', complete: true });
    const storage = memoryStorage({
      '/migration-drafts-profile.json': marker,
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
