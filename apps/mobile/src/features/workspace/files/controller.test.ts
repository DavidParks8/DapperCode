import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { WorkspaceHostClient } from '../api/client';
import type {
  WorkspaceFileEntry,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
} from '../api/protocol';
import {
  FILES_CHANGE_POLL_MS,
  fileName,
  fileNameError,
  formatFileSize,
  joinFilePath,
  parentFilePath,
  useWorkspaceFiles,
} from './controller';

const CWD = '/workspace/demo';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

/** A host failure as the in-process host reports it: a native code under `data`. */
function nativeError(nativeCode: string, message = 'native failure'): Error {
  return Object.assign(new Error(message), { data: { nativeCode } });
}

function listing(path: string, names: string[] = []): WorkspaceFileListResponse {
  return {
    cwd: CWD,
    path,
    entries: names.map((name) => ({
      name,
      path: joinFilePath(path, name),
      kind: 'file',
      bytes: 1,
    })),
    truncated: false,
    limit: 500,
  };
}

function entry(path: string): WorkspaceFileEntry {
  return { name: fileName(path), path, kind: 'file', bytes: 5 };
}

/** An in-memory host: files with revisions, a change token, and per-call overrides. */
function createHost(initial: Record<string, string> = { 'notes.md': 'hello' }) {
  const files = new Map(Object.entries(initial));
  const revisions = new Map([...files.keys()].map((path) => [path, 'r1']));
  let token = 1;
  let writes = 1;
  const read = (path: string): WorkspaceFileReadResponse => {
    const content = files.get(path);
    if (content === undefined) {
      throw nativeError('PATH_NOT_FOUND');
    }
    return {
      path,
      content,
      revision: revisions.get(path) ?? 'r1',
      truncated: false,
      totalBytes: content.length,
    };
  };
  const host = {
    listFiles: jest.fn(async (_cwd: string, path: string) => listing(path, [...files.keys()])),
    changeToken: jest.fn(async () => ({ token: `t${String(token)}` })),
    readFile: jest.fn(async (_cwd: string, path: string) => read(path)),
    writeFile: jest.fn(async (_cwd: string, path: string, content: string, revision: string) => {
      if (revisions.has(path) && revisions.get(path) !== revision) {
        throw nativeError('FILE_REVISION_CONFLICT');
      }
      writes += 1;
      const next = `r${String(writes)}`;
      files.set(path, content);
      revisions.set(path, next);
      token += 1;
      return { path, revision: next };
    }),
    createFile: jest.fn(async (_cwd: string, path: string) => {
      files.set(path, '');
      revisions.set(path, 'r1');
      token += 1;
      return { path, revision: 'r1' };
    }),
    renameFile: jest.fn(async () => ({ ok: true as const })),
    removeFile: jest.fn(async () => ({ ok: true as const })),
  };
  return {
    host,
    client: host as unknown as WorkspaceHostClient,
    /** Changes a file outside the editor, as the agent or Git would. */
    changeOnDisk(path: string, content: string) {
      files.set(path, content);
      revisions.set(path, `outside:${content}`);
      token += 1;
    },
  };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function mount(client: WorkspaceHostClient | null, cwd: string | null = CWD, focused = true) {
  return renderHook(
    (props: { client: WorkspaceHostClient | null; cwd: string | null; focused: boolean }) =>
      useWorkspaceFiles({ host: props.client, cwd: props.cwd, focused: props.focused }),
    { initialProps: { client, cwd, focused } },
  );
}

async function openNotes(hook: ReturnType<typeof mount>, path = 'notes.md') {
  await act(async () => {
    await hook.result.current.openFile(entry(path));
  });
}

function setAppState(state: string): void {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
}

beforeEach(() => {
  jest.useFakeTimers();
  setAppState('active');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('file path and size helpers', () => {
  it('joins, splits, and names workspace-relative paths', () => {
    expect(joinFilePath('', 'a.md')).toBe('a.md');
    expect(joinFilePath('src/lib', 'a.md')).toBe('src/lib/a.md');
    expect(parentFilePath('src/lib/a.md')).toBe('src/lib');
    expect(parentFilePath('a.md')).toBe('');
    expect(fileName('src/lib/a.md')).toBe('a.md');
  });

  it('rejects empty, nested, and dot names', () => {
    expect(fileNameError('  ')).toBe('Enter a name.');
    expect(fileNameError('a/b')).toBe('Names cannot contain “/”.');
    expect(fileNameError(' . ')).toBe('Choose a different name.');
    expect(fileNameError('..')).toBe('Choose a different name.');
    expect(fileNameError(' notes.md ')).toBeNull();
  });

  it('formats sizes in B, KB with one decimal under 10 KB, and MB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(20 * 1024)).toBe('20 KB');
    expect(formatFileSize(3.25 * 1024 * 1024)).toBe('3.3 MB');
  });
});

describe('files controller without a workspace', () => {
  it('does nothing and refuses every write until a host and workspace exist', async () => {
    const hook = mount(null, null);
    await settle(FILES_CHANGE_POLL_MS * 2);

    expect(hook.result.current.listing).toBeNull();
    expect(hook.result.current.file).toBeNull();
    let results: unknown[] = [];
    await act(async () => {
      await hook.result.current.openFile(entry('notes.md'));
      results = [
        await hook.result.current.save(),
        await hook.result.current.overwrite(),
        await hook.result.current.createFile('new.md'),
        await hook.result.current.removeEntry(entry('notes.md')),
      ];
      await hook.result.current.refresh();
    });
    expect(results).toEqual([false, false, false, false]);
    expect(hook.result.current.file).toBeNull();
    expect(hook.result.current.error).toBeNull();
  });
});

describe('files controller folder listing', () => {
  it('shows friendly copy for a typed listing failure and stops loading', async () => {
    const { host, client } = createHost();
    host.listFiles.mockRejectedValueOnce(nativeError('WORKSPACE_NOT_FOUND'));
    const hook = mount(client);
    await settle();

    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.listing).toBeNull();
    expect(hook.result.current.error).toBe('That workspace is no longer on this device.');
  });

  it('ignores a slow listing for a folder the user already left', async () => {
    const { host, client } = createHost();
    const slowRoot = deferred<WorkspaceFileListResponse>();
    const slowRootFailure = deferred<WorkspaceFileListResponse>();
    host.listFiles.mockReturnValueOnce(slowRoot.promise);
    const hook = mount(client);
    await settle();

    act(() => hook.result.current.openDirectory('src'));
    await settle();
    expect(hook.result.current.directory).toBe('src');
    expect(hook.result.current.listing?.path).toBe('src');

    // The root listing lands late; it must not replace the folder now on screen.
    slowRoot.resolve(listing('', ['stale.md']));
    await settle();
    expect(hook.result.current.listing?.path).toBe('src');

    // A late failure for a folder already left is not shown either.
    host.listFiles.mockReturnValueOnce(slowRootFailure.promise);
    act(() => hook.result.current.openDirectory(''));
    act(() => hook.result.current.openDirectory('src'));
    slowRootFailure.reject(nativeError('PATH_NOT_FOUND'));
    await settle();
    expect(hook.result.current.directory).toBe('src');
    expect(hook.result.current.error).toBeNull();
  });

  it('refuses to change folders while a file is open', async () => {
    const { client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);

    act(() => hook.result.current.openDirectory('src'));
    expect(hook.result.current.directory).toBe('');
    expect(hook.result.current.file?.path).toBe('notes.md');
  });
});

describe('files controller opening and editing', () => {
  it('reports a failed open with the host message, or a fallback naming the file', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();

    host.readFile.mockRejectedValueOnce(nativeError('FILE_NOT_TEXT'));
    await openNotes(hook);
    expect(hook.result.current.error).toBe("This file isn't text, so it can't be shown here.");
    expect(hook.result.current.opening).toBeNull();
    expect(hook.result.current.file).toBeNull();

    host.readFile.mockRejectedValueOnce(new Error('  '));
    await openNotes(hook);
    expect(hook.result.current.error).toBe('Could not open notes.md.');
  });

  it('opens a truncated file read-only: edits are ignored and it always closes', async () => {
    const { host, client } = createHost();
    host.readFile.mockResolvedValueOnce({
      path: 'big.log',
      content: 'head',
      revision: 'r1',
      truncated: true,
      totalBytes: 10_000_000,
    });
    const hook = mount(client);
    await settle();
    await openNotes(hook, 'big.log');

    act(() => hook.result.current.setDraft('changed'));
    expect(hook.result.current.file?.draft).toBe('head');
    expect(hook.result.current.dirty).toBe(false);

    let closed = false;
    act(() => {
      closed = hook.result.current.closeFile();
    });
    expect(closed).toBe(true);
    expect(hook.result.current.file).toBeNull();
  });

  it('refuses to close a dirty file, explains why, and clears the warning on the next edit', async () => {
    const { client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);

    act(() => hook.result.current.setDraft('hello world'));
    let closed = true;
    act(() => {
      closed = hook.result.current.closeFile();
    });
    expect(closed).toBe(false);
    expect(hook.result.current.unsavedBlocked).toBe(true);
    expect(hook.result.current.file?.draft).toBe('hello world');

    act(() => hook.result.current.setDraft('hello world!'));
    expect(hook.result.current.unsavedBlocked).toBe(false);
  });
});

describe('files controller saving', () => {
  it('saves the draft, adopts the new revision, and refreshes the listing', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    act(() => hook.result.current.setDraft('hello world'));
    host.listFiles.mockClear();

    let saved = false;
    await act(async () => {
      saved = await hook.result.current.save();
    });

    expect(saved).toBe(true);
    expect(host.writeFile).toHaveBeenCalledWith(CWD, 'notes.md', 'hello world', 'r1');
    expect(hook.result.current.file).toMatchObject({
      original: 'hello world',
      draft: 'hello world',
      revision: 'r2',
      totalBytes: 11,
    });
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.saving).toBe(false);
    expect(hook.result.current.notice).toBe('Saved notes.md.');
    expect(host.listFiles).toHaveBeenCalledWith(CWD, '');
  });

  it('flags a revision conflict, then overwrites with the latest revision on request', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    act(() => hook.result.current.setDraft('mine'));
    harness.changeOnDisk('notes.md', 'theirs');

    let saved = true;
    await act(async () => {
      saved = await hook.result.current.save();
    });
    expect(saved).toBe(false);
    expect(hook.result.current.conflict).toBe(true);
    expect(hook.result.current.error).toBe('The file changed since you opened it.');
    expect(hook.result.current.file?.draft).toBe('mine');
    expect(hook.result.current.saving).toBe(false);

    await act(async () => {
      saved = await hook.result.current.overwrite();
    });
    expect(saved).toBe(true);
    expect(harness.host.writeFile).toHaveBeenLastCalledWith(
      CWD,
      'notes.md',
      'mine',
      'outside:theirs',
    );
    expect(hook.result.current.conflict).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.file).toMatchObject({ original: 'mine', revision: 'r2' });
    expect(hook.result.current.dirty).toBe(false);
  });

  it('keeps a non-conflict save failure out of the conflict flow', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    act(() => hook.result.current.setDraft('x'.repeat(10)));
    host.writeFile.mockRejectedValueOnce(nativeError('FILE_TOO_LARGE'));

    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.conflict).toBe(false);
    expect(hook.result.current.error).toBe('This file is too large to save here.');
    expect(hook.result.current.dirty).toBe(true);
  });

  it('reports an overwrite whose fresh read fails, keeping the draft', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    act(() => hook.result.current.setDraft('mine'));
    host.readFile.mockRejectedValueOnce(nativeError('PATH_NOT_FOUND'));

    let saved = true;
    await act(async () => {
      saved = await hook.result.current.overwrite();
    });
    expect(saved).toBe(false);
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe(
      'That file or folder no longer exists. Refresh to see the current files.',
    );
    expect(hook.result.current.file?.draft).toBe('mine');
  });
});

describe('files controller outside changes', () => {
  it('reloads a clean open file when the change token moves', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    // The first poll only records the starting token.
    await settle(FILES_CHANGE_POLL_MS);

    harness.changeOnDisk('notes.md', 'agent edit');
    await settle(FILES_CHANGE_POLL_MS);

    expect(hook.result.current.file).toMatchObject({
      original: 'agent edit',
      draft: 'agent edit',
      revision: 'outside:agent edit',
    });
    expect(hook.result.current.changedOnDisk).toBe(false);
  });

  it('flags, but never reloads, a dirty file changed on disk; Discard then shows the disk copy', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    await settle(FILES_CHANGE_POLL_MS);
    act(() => hook.result.current.setDraft('my edit'));
    harness.host.readFile.mockClear();

    harness.changeOnDisk('notes.md', 'agent edit');
    await settle(FILES_CHANGE_POLL_MS);
    expect(hook.result.current.changedOnDisk).toBe(true);
    expect(hook.result.current.file?.draft).toBe('my edit');
    expect(harness.host.readFile).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.discardEdits();
    });
    expect(hook.result.current.file).toMatchObject({
      original: 'agent edit',
      draft: 'agent edit',
      revision: 'outside:agent edit',
    });
    expect(hook.result.current.changedOnDisk).toBe(false);
  });

  it('discards edits locally without a read when nothing changed on disk', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    act(() => hook.result.current.setDraft('my edit'));
    act(() => {
      hook.result.current.closeFile();
    });
    host.readFile.mockClear();

    await act(async () => {
      await hook.result.current.discardEdits();
    });
    expect(hook.result.current.file?.draft).toBe('hello');
    expect(hook.result.current.unsavedBlocked).toBe(false);
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('does not poll while the app is in the background or inactive', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    await settle(FILES_CHANGE_POLL_MS);
    harness.host.changeToken.mockClear();

    for (const state of ['background', 'inactive'] as const) {
      setAppState(state);
      harness.changeOnDisk('notes.md', `while ${state}`);
      await settle(FILES_CHANGE_POLL_MS);
      expect(harness.host.changeToken).not.toHaveBeenCalled();
      expect(hook.result.current.file?.original).toBe('hello');
    }

    setAppState('active');
    await settle(FILES_CHANGE_POLL_MS);
    expect(hook.result.current.file?.original).toBe('while inactive');
  });

  it('stops polling when unfocused and treats an unreadable token as no change', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    await settle(FILES_CHANGE_POLL_MS);

    harness.host.changeToken.mockRejectedValue(new Error('offline'));
    harness.changeOnDisk('notes.md', 'unseen');
    await settle(FILES_CHANGE_POLL_MS);
    expect(hook.result.current.file?.original).toBe('hello');
    expect(hook.result.current.error).toBeNull();

    harness.host.changeToken.mockClear();
    hook.rerender({ client: harness.client, cwd: CWD, focused: false });
    await settle(FILES_CHANGE_POLL_MS * 2);
    expect(harness.host.changeToken).not.toHaveBeenCalled();
  });

  it('drops a background reload when a save lands while it is in flight', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    const slowRead = deferred<WorkspaceFileReadResponse>();
    harness.host.readFile.mockReturnValueOnce(slowRead.promise);

    let reload!: Promise<void>;
    act(() => {
      reload = hook.result.current.reloadFromDisk();
    });
    act(() => hook.result.current.setDraft('saved meanwhile'));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.file?.revision).toBe('r2');

    slowRead.resolve({
      path: 'notes.md',
      content: 'stale disk copy',
      revision: 'r1',
      truncated: false,
      totalBytes: 15,
    });
    await act(async () => {
      await reload;
    });
    expect(hook.result.current.file).toMatchObject({
      original: 'saved meanwhile',
      draft: 'saved meanwhile',
      revision: 'r2',
    });
    expect(hook.result.current.changedOnDisk).toBe(false);
  });

  it('reports a background reload failure without touching the open file', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    host.readFile.mockRejectedValueOnce(new Error(''));

    await act(async () => {
      await hook.result.current.reloadFromDisk();
    });
    expect(hook.result.current.error).toBe('Could not reload the file.');
    expect(hook.result.current.file?.original).toBe('hello');
  });

  it('refresh re-reads the token and listing and reloads only a clean file', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);

    harness.changeOnDisk('notes.md', 'v2');
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.file?.original).toBe('v2');

    act(() => hook.result.current.setDraft('dirty'));
    harness.changeOnDisk('notes.md', 'v3');
    harness.host.readFile.mockClear();
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(harness.host.readFile).not.toHaveBeenCalled();
    expect(hook.result.current.file).toMatchObject({ original: 'v2', draft: 'dirty' });
    // The refreshed token is the baseline: the next poll does not re-report the same change.
    await settle(FILES_CHANGE_POLL_MS);
    expect(hook.result.current.changedOnDisk).toBe(false);
  });
});

describe('files controller background reload races', () => {
  it('does nothing when asked to reload with no file open', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();

    await act(async () => {
      await hook.result.current.reloadFromDisk();
    });
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('keeps edits typed while a reload is in flight and flags the disk change instead', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    const slowRead = deferred<WorkspaceFileReadResponse>();
    host.readFile.mockReturnValueOnce(slowRead.promise);

    let reload!: Promise<void>;
    act(() => {
      reload = hook.result.current.reloadFromDisk();
    });
    act(() => hook.result.current.setDraft('typed during reload'));
    slowRead.resolve({
      path: 'notes.md',
      content: 'agent edit',
      revision: 'r1',
      truncated: false,
      totalBytes: 10,
    });
    await act(async () => {
      await reload;
    });

    expect(hook.result.current.file).toMatchObject({
      original: 'hello',
      draft: 'typed during reload',
    });
    expect(hook.result.current.changedOnDisk).toBe(true);
    expect(hook.result.current.dirty).toBe(true);
  });

  it('does not reopen a file closed while its reload was in flight', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    const slowRead = deferred<WorkspaceFileReadResponse>();
    host.readFile.mockReturnValueOnce(slowRead.promise);

    let reload!: Promise<void>;
    act(() => {
      reload = hook.result.current.reloadFromDisk();
    });
    act(() => {
      hook.result.current.closeFile();
    });
    slowRead.resolve({
      path: 'notes.md',
      content: 'late',
      revision: 'r9',
      truncated: false,
      totalBytes: 4,
    });
    await act(async () => {
      await reload;
    });
    expect(hook.result.current.file).toBeNull();
  });

  it('treats the first readable token as the baseline when the initial read failed', async () => {
    const harness = createHost();
    harness.host.changeToken.mockRejectedValueOnce(new Error('not ready'));
    const hook = mount(harness.client);
    await settle();
    await openNotes(hook);
    harness.host.listFiles.mockClear();
    harness.host.readFile.mockClear();

    harness.changeOnDisk('notes.md', 'before baseline');
    await settle(FILES_CHANGE_POLL_MS);
    expect(harness.host.listFiles).not.toHaveBeenCalled();
    expect(harness.host.readFile).not.toHaveBeenCalled();

    harness.changeOnDisk('notes.md', 'after baseline');
    await settle(FILES_CHANGE_POLL_MS);
    expect(harness.host.listFiles).toHaveBeenCalledTimes(1);
    expect(hook.result.current.file?.original).toBe('after baseline');
  });

  it('only refreshes the listing for a change while no file is open', async () => {
    const harness = createHost();
    const hook = mount(harness.client);
    await settle();
    await settle(FILES_CHANGE_POLL_MS);
    harness.host.listFiles.mockClear();

    await act(async () => {
      await harness.client.createFile(CWD, 'added.md');
    });
    await settle(FILES_CHANGE_POLL_MS);
    expect(harness.host.listFiles).toHaveBeenCalledTimes(1);
    expect(hook.result.current.listing?.entries.map((item) => item.name)).toEqual([
      'notes.md',
      'added.md',
    ]);
    expect(harness.host.readFile).not.toHaveBeenCalled();
  });

  it('refuses to save an open file after the host disconnects', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    act(() => hook.result.current.setDraft('unsent'));

    hook.rerender({ client: null, cwd: CWD, focused: true });
    let saved = true;
    await act(async () => {
      saved = await hook.result.current.save();
    });
    expect(saved).toBe(false);
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(hook.result.current.file?.draft).toBe('unsent');
    expect(hook.result.current.dirty).toBe(true);
  });

  it('drops late results after the screen unmounts', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();
    await openNotes(hook);
    const slowRead = deferred<WorkspaceFileReadResponse>();
    host.readFile.mockReturnValueOnce(slowRead.promise);
    const errors = jest.spyOn(console, 'error');

    let reload!: Promise<void>;
    act(() => {
      reload = hook.result.current.reloadFromDisk();
    });
    hook.unmount();
    slowRead.reject(new Error('gone'));
    await reload;
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('files controller create, rename, and delete', () => {
  it('creates a file in the open folder, announces it, and opens it', async () => {
    const { host, client } = createHost({ 'src/a.md': 'a' });
    const hook = mount(client);
    await settle();
    act(() => hook.result.current.openDirectory('src'));
    await settle();

    let created = false;
    await act(async () => {
      created = await hook.result.current.createFile('  b.md ');
    });
    expect(created).toBe(true);
    expect(host.createFile).toHaveBeenCalledWith(CWD, 'src/b.md');
    expect(hook.result.current.file).toMatchObject({ path: 'src/b.md', draft: '' });
    expect(hook.result.current.error).toBeNull();
  });

  it('renames within the same folder and deletes by path', async () => {
    const { host, client } = createHost({ 'src/a.md': 'a' });
    const hook = mount(client);
    await settle();

    await act(async () => {
      await hook.result.current.renameEntry(entry('src/a.md'), ' c.md ');
    });
    expect(host.renameFile).toHaveBeenCalledWith(CWD, 'src/a.md', 'src/c.md');
    expect(hook.result.current.notice).toBe('Renamed a.md to c.md.');

    await act(async () => {
      await hook.result.current.removeEntry(entry('src/c.md'));
    });
    expect(host.removeFile).toHaveBeenCalledWith(CWD, 'src/c.md');
    expect(hook.result.current.notice).toBe('Deleted c.md.');
  });

  it('reports failed mutations with typed copy or the action fallback', async () => {
    const { host, client } = createHost();
    const hook = mount(client);
    await settle();

    host.createFile.mockRejectedValueOnce(nativeError('PATH_EXISTS'));
    let created = true;
    await act(async () => {
      created = await hook.result.current.createFile('notes.md');
    });
    expect(created).toBe(false);
    expect(hook.result.current.error).toBe('Something with that name already exists here.');
    expect(hook.result.current.file).toBeNull();

    host.removeFile.mockRejectedValueOnce(new Error(''));
    let removed = true;
    await act(async () => {
      removed = await hook.result.current.removeEntry(entry('notes.md'));
    });
    expect(removed).toBe(false);
    expect(hook.result.current.error).toBe('Could not delete notes.md.');
  });
});
