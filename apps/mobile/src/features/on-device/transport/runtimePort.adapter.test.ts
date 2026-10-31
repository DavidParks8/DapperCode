import type { LocalContextLoader } from '../models/engine';
import { OnDeviceNativeError } from '../native/services.errors';
import { OnDeviceOfflineError } from '../runtime/network';
import { OnDeviceRuntime } from '../runtime/runtime';
import { createFakeOnDeviceNative, FakeLlama, FakeNetwork } from '../runtime/testing';
import type { LocalAgentPort } from './port';
import { createRuntimeAgentPort } from './runtimePort';

jest.mock('expo-crypto', () => {
  let counter = 0;
  return {
    randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  };
});

let mockLlama = new FakeLlama();
jest.mock('../models/engine', () => ({
  ...jest.requireActual<object>('../models/engine'),
  loadNativeModelContext: (...args: Parameters<LocalContextLoader>) => mockLlama.loader(...args),
}));

const QWEN = 'qwen3-1.7b-q4-k-m';
const WORKSPACE = 'ws-one';
const BUSY = 'Wait for the active workspace operation to settle.';

const runtimes: OnDeviceRuntime[] = [];

afterEach(async () => {
  mockLlama.holdLoads = false;
  mockLlama.finishLoad();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function setup() {
  mockLlama = new FakeLlama();
  const fake = createFakeOnDeviceNative(mockLlama, { downloaded: [QWEN] });
  const network = new FakeNetwork();
  const runtime = new OnDeviceRuntime(fake.native, {
    network,
    emitIntervalMs: 0,
    threadProgressDelayMs: 0,
  });
  runtimes.push(runtime);
  await runtime.initialize();
  const port = createRuntimeAgentPort(runtime);
  return { fake, native: fake.native, network, runtime, port };
}

/**
 * Replaces a native method with one that records the runtime's workspace activity label at call
 * time, so each mutation is proven to run inside `workspaceTask` with its user-facing label.
 */
function observeLabel<K extends keyof ReturnType<typeof createFakeOnDeviceNative>['native']>(
  harness: Awaited<ReturnType<typeof setup>>,
  method: K,
): { labels: (string | null)[]; args: unknown[][] } {
  const labels: (string | null)[] = [];
  const args: unknown[][] = [];
  const native = harness.native as unknown as Record<string, (...values: unknown[]) => unknown>;
  const original = native[method]!.bind(harness.native);
  native[method] = (...values: unknown[]) => {
    labels.push(harness.runtime.workspaceActivity());
    args.push(values);
    return original(...values);
  };
  return { labels, args };
}

describe('runtime agent port workspace mutations', () => {
  const cases: {
    name: string;
    method: keyof ReturnType<typeof createFakeOnDeviceNative>['native'];
    label: string;
    call: (port: LocalAgentPort) => Promise<unknown>;
    args: unknown[];
  }[] = [
    {
      name: 'stage',
      method: 'stageWorkspaceGit',
      label: 'Staging changes',
      call: (port) => port.git.stage(WORKSPACE, 'a.txt'),
      args: [WORKSPACE, 'a.txt'],
    },
    {
      name: 'unstage',
      method: 'unstageWorkspaceGit',
      label: 'Unstaging changes',
      call: (port) => port.git.unstage(WORKSPACE, null),
      args: [WORKSPACE, null],
    },
    {
      name: 'switch branch',
      method: 'switchWorkspaceGitBranch',
      label: 'Switching branch',
      call: (port) => port.git.switchBranch(WORKSPACE, 'feature'),
      args: [WORKSPACE, 'feature'],
    },
    {
      name: 'discard',
      method: 'discardWorkspaceGit',
      label: 'Discarding changes',
      call: (port) => port.git.discard(WORKSPACE, 'a.txt', true),
      args: [WORKSPACE, 'a.txt', true],
    },
    {
      name: 'create branch (and switch to it)',
      method: 'createWorkspaceGitBranch',
      label: 'Creating branch',
      call: (port) => port.git.createBranch(WORKSPACE, 'topic'),
      args: [WORKSPACE, 'topic', true],
    },
    {
      name: 'save file with its revision',
      method: 'writeWorkspaceFile',
      label: 'Saving file',
      call: (port) => port.files.write(WORKSPACE, 'notes.md', 'hello', 'rev-1'),
      args: [WORKSPACE, 'notes.md', 'hello', 'rev-1'],
    },
    {
      name: 'rename entry',
      method: 'renameWorkspaceEntry',
      label: 'Renaming',
      call: (port) => port.files.rename(WORKSPACE, 'a.txt', 'b.txt'),
      args: [WORKSPACE, 'a.txt', 'b.txt'],
    },
    {
      name: 'delete entry',
      method: 'removeWorkspaceEntry',
      label: 'Deleting',
      call: (port) => port.files.remove(WORKSPACE, 'a.txt'),
      args: [WORKSPACE, 'a.txt'],
    },
  ];

  it.each(cases)(
    'runs $name as a labelled workspace task',
    async ({ method, label, call, args }) => {
      const harness = await setup();
      const observed = observeLabel(harness, method);

      await call(harness.port);

      expect(observed.labels).toEqual([label]);
      expect(observed.args).toEqual([args]);
      expect(harness.runtime.workspaceActivity()).toBeNull();
      expect(harness.runtime.workspaceBusy()).toBe(false);
    },
  );

  it('refuses a second mutation while one is in flight and accepts it once the first settles', async () => {
    const harness = await setup();
    const save = deferred<string>();
    const write = jest.fn(() => save.promise);
    harness.native.writeWorkspaceFile = write;
    const stage = jest.spyOn(harness.native, 'stageWorkspaceGit');

    const saving = harness.port.files.write(WORKSPACE, 'a.txt', 'x', 'rev-1');
    await flush();
    expect(harness.runtime.workspaceActivity()).toBe('Saving file');

    await expect(harness.port.git.stage(WORKSPACE, 'a.txt')).rejects.toThrow(BUSY);
    await expect(harness.port.files.remove(WORKSPACE, 'a.txt')).rejects.toThrow(BUSY);
    expect(stage).not.toHaveBeenCalled();

    save.resolve('rev-2');
    await expect(saving).resolves.toBe('rev-2');
    expect(harness.runtime.workspaceActivity()).toBeNull();

    await harness.port.git.stage(WORKSPACE, 'a.txt');
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('releases the workspace slot when a native mutation fails with a typed error', async () => {
    const harness = await setup();
    harness.native.writeWorkspaceFile = jest.fn(async () => {
      throw new OnDeviceNativeError('FILE_REVISION_CONFLICT', 'The file changed.');
    });

    await expect(harness.port.files.write(WORKSPACE, 'a.txt', 'x', 'stale')).rejects.toMatchObject({
      code: 'FILE_REVISION_CONFLICT',
    });
    expect(harness.runtime.workspaceActivity()).toBeNull();

    const stage = jest.spyOn(harness.native, 'stageWorkspaceGit');
    await harness.port.git.stage(WORKSPACE, 'a.txt');
    expect(stage).toHaveBeenCalledTimes(1);
  });
});

describe('runtime agent port commit', () => {
  it('requires a Git author before committing and never reaches native Git without one', async () => {
    const harness = await setup();
    const commit = jest.spyOn(harness.native, 'commitWorkspaceGit');

    await expect(harness.port.git.commit(WORKSPACE, 'Initial')).rejects.toThrow(
      'Set your Git author name and email for On this iPhone first.',
    );
    expect(commit).not.toHaveBeenCalled();
    expect(harness.runtime.workspaceActivity()).toBeNull();
  });

  it('commits with the saved author inside a "Committing" task', async () => {
    const harness = await setup();
    await harness.runtime.saveAuthor({ name: ' Ada ', email: ' ada@example.com ' });
    const observed = observeLabel(harness, 'commitWorkspaceGit');

    await harness.port.git.commit(WORKSPACE, 'Initial');

    expect(observed.labels).toEqual(['Committing']);
    expect(observed.args).toEqual([[WORKSPACE, 'Initial', 'Ada', 'ada@example.com']]);
  });
});

describe('runtime agent port network Git operations', () => {
  it.each([
    ['fetch', 'fetchWorkspaceGit', (port: LocalAgentPort) => port.git.fetch(WORKSPACE)],
    ['pull', 'pullWorkspaceGit', (port: LocalAgentPort) => port.git.pull(WORKSPACE)],
    ['push', 'pushWorkspaceGit', (port: LocalAgentPort) => port.git.push(WORKSPACE)],
  ] as const)(
    'fails %s fast while offline without touching native Git, then works once back online',
    async (action, method, call) => {
      const harness = await setup();
      const native = jest.spyOn(harness.native, method);
      harness.network.set('offline');

      const offline = call(harness.port);
      await expect(offline).rejects.toBeInstanceOf(OnDeviceOfflineError);
      await expect(offline).rejects.toThrow(`Connect to the internet to ${action}.`);
      expect(native).not.toHaveBeenCalled();
      expect(harness.runtime.workspaceActivity()).toBeNull();

      harness.network.set('online');
      await call(harness.port);
      // Signed out: public remotes are reached without a credential.
      expect(native).toHaveBeenCalledWith(WORKSPACE, null);
    },
  );

  it('labels fetch and pull and returns the pull outcome', async () => {
    const harness = await setup();
    const fetch = observeLabel(harness, 'fetchWorkspaceGit');
    const pull = observeLabel(harness, 'pullWorkspaceGit');

    await harness.port.git.fetch(WORKSPACE);
    await expect(harness.port.git.pull(WORKSPACE)).resolves.toEqual({
      outcome: 'up-to-date',
      from: 'a',
      to: 'a',
    });

    expect(fetch.labels).toEqual(['Fetching']);
    expect(pull.labels).toEqual(['Pulling']);
  });
});

describe('runtime agent port Git initialisation', () => {
  it('refreshes the workspace list after init so the repository badge updates', async () => {
    const harness = await setup();
    const list = jest.spyOn(harness.native, 'listWorkspaces');
    const observed = observeLabel(harness, 'initWorkspaceGit');

    await harness.port.git.init(WORKSPACE, 'main', 'https://github.com/acme/demo.git');

    expect(observed.labels).toEqual(['Initializing Git']);
    expect(observed.args).toEqual([[WORKSPACE, 'main', 'https://github.com/acme/demo.git']]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the workspace list when init fails part-way', async () => {
    const harness = await setup();
    const list = jest.spyOn(harness.native, 'listWorkspaces');
    harness.native.initWorkspaceGit = jest.fn(async () => {
      throw new OnDeviceNativeError('GIT_ALREADY_REPOSITORY', 'Already a repository.');
    });

    await expect(harness.port.git.init(WORKSPACE, 'main', null)).rejects.toMatchObject({
      code: 'GIT_ALREADY_REPOSITORY',
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(harness.runtime.workspaceActivity()).toBeNull();
  });
});

describe('runtime agent port read-only Git and workspace queries', () => {
  it('reads status, history, and branches directly and asks for the full diff', async () => {
    const harness = await setup();
    const diff = jest.spyOn(harness.native, 'getWorkspaceGitDiff');

    await expect(harness.port.git.status(WORKSPACE)).resolves.toMatchObject({ branch: 'main' });
    await expect(harness.port.git.history(WORKSPACE)).resolves.toEqual({ commits: [] });
    await expect(harness.port.git.branches(WORKSPACE)).resolves.toMatchObject({
      branches: [{ name: 'main', current: true }],
    });
    await harness.port.git.diff(WORKSPACE);
    expect(diff).toHaveBeenCalledWith(WORKSPACE, null);
  });

  it('describes a workspace by its reported current branch and origin', async () => {
    const harness = await setup();
    harness.native.getWorkspaceGitBranches = jest.fn(async () => ({
      current: 'release',
      branches: [{ name: 'main', remote: false, current: true }],
    }));

    await expect(harness.port.workspaceAdmin.metadata(WORKSPACE)).resolves.toEqual({
      branch: 'release',
      origin: 'https://github.com/acme/demo.git',
    });
  });

  it('falls back to the branch marked current, then to null when none is', async () => {
    const harness = await setup();
    await expect(harness.port.workspaceAdmin.metadata(WORKSPACE)).resolves.toEqual({
      branch: 'main',
      origin: 'https://github.com/acme/demo.git',
    });

    harness.native.getWorkspaceGitBranches = jest.fn(async () => ({
      branches: [{ name: 'main', remote: false, current: false }],
    }));
    await expect(harness.port.workspaceAdmin.metadata(WORKSPACE)).resolves.toMatchObject({
      branch: null,
    });
  });

  it('keeps whichever half of the metadata resolved when the other fails', async () => {
    const harness = await setup();
    harness.native.getWorkspaceGitBranches = jest.fn(async () => {
      throw new OnDeviceNativeError('GIT_NOT_REPOSITORY', 'Not a repository.');
    });
    await expect(harness.port.workspaceAdmin.metadata(WORKSPACE)).resolves.toEqual({
      branch: null,
      origin: 'https://github.com/acme/demo.git',
    });

    harness.native.getWorkspaceGitBranches = jest.fn(async () => ({
      branches: [{ name: 'main', remote: false, current: true }],
    }));
    harness.native.getWorkspaceGitOrigin = jest.fn(async () => {
      throw new OnDeviceNativeError('GIT_NO_ORIGIN', 'No origin.');
    });
    await expect(harness.port.workspaceAdmin.metadata(WORKSPACE)).resolves.toEqual({
      branch: 'main',
      origin: null,
    });
  });

  it('subscribes to clone progress and removes exactly its own native listener', async () => {
    const harness = await setup();
    const before = harness.fake.gitProgressListeners.size;
    const progress: unknown[] = [];

    const unsubscribe = harness.port.workspaceAdmin.onCloneProgress((value) =>
      progress.push(value),
    );
    expect(harness.fake.gitProgressListeners.size).toBe(before + 1);
    harness.fake.emitGitTransferProgress({
      active: true,
      cancelled: false,
      completed: 1,
      total: 2,
    });
    expect(progress).toEqual([{ active: true, cancelled: false, completed: 1, total: 2 }]);

    unsubscribe();
    expect(harness.fake.gitProgressListeners.size).toBe(before);
    harness.fake.emitGitTransferProgress({
      active: false,
      cancelled: false,
      completed: 2,
      total: 2,
    });
    expect(progress).toHaveLength(1);
  });

  it('forwards transfer progress, cancellation, and change tokens to native', async () => {
    const harness = await setup();
    expect(harness.port.workspaceAdmin.cloneProgress()).toEqual({
      active: false,
      cancelled: false,
      completed: 0,
      total: 0,
    });
    harness.port.workspaceAdmin.cancelTransfer();
    expect(harness.fake.calls).toContain('cancelGitTransfer');
    await expect(harness.port.workspaceAdmin.changeToken(WORKSPACE)).resolves.toMatch(
      /^token-ws-one-/,
    );
  });

  it('refreshes the runtime workspace list on request', async () => {
    const harness = await setup();
    const list = jest.spyOn(harness.native, 'listWorkspaces');
    await harness.port.refreshWorkspaces();
    expect(list).toHaveBeenCalledTimes(1);
    expect(harness.port.workspaces()).toEqual([
      { id: WORKSPACE, name: 'Demo', isRepository: true },
    ]);
  });
});

describe('runtime agent port conversations and models', () => {
  it('reports the remembered workspace and model as defaults', async () => {
    const harness = await setup();
    expect(harness.port.defaults()).toEqual({ workspaceId: null, modelId: null });

    await harness.runtime.selectWorkspace(WORKSPACE);
    await harness.runtime.chooseModel(QWEN);
    expect(harness.port.defaults()).toEqual({ workspaceId: WORKSPACE, modelId: QWEN });
  });

  it('merges a thread patch and persists it before resolving', async () => {
    const harness = await setup();
    const thread = await harness.port.createThread(WORKSPACE, QWEN);
    const saved = jest.spyOn(harness.runtime.threads, 'save');

    const next = await harness.port.updateThread(thread.id, { title: 'Renamed chat' });

    expect(next).toMatchObject({ id: thread.id, title: 'Renamed chat', modelId: QWEN });
    expect(saved).toHaveBeenCalledWith(thread.id);
    expect(harness.port.thread(thread.id)).toMatchObject({ title: 'Renamed chat' });
  });

  it('reports a model as loading with progress, then loaded with its context size', async () => {
    const harness = await setup();
    expect(harness.port.modelChoices()).toEqual([
      expect.objectContaining({ residency: 'idle', loadProgress: 0, contextTokens: null }),
    ]);

    mockLlama.holdLoads = true;
    const load = harness.runtime.models.load(QWEN);
    await flush();
    mockLlama.loadProgress(40);
    await flush();
    const [loading] = harness.port.modelChoices();
    expect(loading).toMatchObject({ residency: 'loading', contextTokens: null });
    expect(loading!.loadProgress).toBeGreaterThan(0);

    mockLlama.finishLoad();
    await load;
    const [loaded] = harness.port.modelChoices();
    expect(loaded).toMatchObject({ residency: 'loaded', loadProgress: 0 });
    expect(loaded!.contextTokens).toEqual(harness.runtime.models.snapshot().contextTokens);
    expect(loaded!.contextTokens).toBeGreaterThan(0);
  });
});

describe('runtime agent port workspace administration and files', () => {
  it('creates, selects, renames, and deletes workspaces, clearing a deleted selection', async () => {
    const harness = await setup();

    const created = await harness.port.workspaceAdmin.create('Scratch');
    expect(created).toEqual({ id: 'ws-2', name: 'Scratch', isRepository: false });
    expect(harness.port.workspaces().map((workspace) => workspace.id)).toEqual([WORKSPACE, 'ws-2']);
    expect(harness.port.defaults().workspaceId).toBe('ws-2');

    await harness.port.workspaceAdmin.select(WORKSPACE);
    expect(harness.port.defaults().workspaceId).toBe(WORKSPACE);

    await expect(harness.port.workspaceAdmin.rename('ws-2', 'Renamed')).resolves.toEqual({
      id: 'ws-2',
      name: 'Renamed',
      isRepository: true,
    });

    await harness.port.workspaceAdmin.delete(WORKSPACE);
    expect(harness.port.workspaces().map((workspace) => workspace.id)).toEqual(['ws-2']);
    expect(harness.port.defaults().workspaceId).toBeNull();
  });

  it('refuses to clone while offline and clones into a selected workspace once online', async () => {
    const harness = await setup();
    const clone = jest.spyOn(harness.native, 'cloneWorkspace');
    harness.network.set('offline');

    await expect(
      harness.port.workspaceAdmin.clone('demo', 'https://github.com/acme/demo.git'),
    ).rejects.toBeInstanceOf(OnDeviceOfflineError);
    expect(clone).not.toHaveBeenCalled();

    harness.network.set('online');
    const listed = harness.native.listWorkspaces.bind(harness.native);
    harness.native.listWorkspaces = async () => [
      ...(await listed()),
      { id: 'cloned', name: 'demo', isRepository: true },
    ];
    const observed = observeLabel(harness, 'cloneWorkspace');
    await expect(
      harness.port.workspaceAdmin.clone('demo', 'https://github.com/acme/demo.git'),
    ).resolves.toMatchObject({ id: 'cloned' });
    expect(observed.labels).toEqual(['Cloning repository']);
    expect(observed.args).toEqual([['demo', 'https://github.com/acme/demo.git', null]]);
    expect(harness.port.defaults().workspaceId).toBe('cloned');
  });

  it('lists and reads files without taking the workspace slot', async () => {
    mockLlama = new FakeLlama();
    const fake = createFakeOnDeviceNative(mockLlama, {
      downloaded: [QWEN],
      files: { [`${WORKSPACE}:notes.md`]: 'hello world' },
    });
    const runtime = new OnDeviceRuntime(fake.native, { emitIntervalMs: 0 });
    runtimes.push(runtime);
    await runtime.initialize();
    const port = createRuntimeAgentPort(runtime);
    const save = deferred<string>();
    fake.native.writeWorkspaceFile = jest.fn(() => save.promise);

    const saving = port.files.write(WORKSPACE, 'other.md', 'x', null);
    await flush();
    // Reads stay available while a save holds the workspace slot.
    await expect(port.files.list(WORKSPACE, '', 10)).resolves.toEqual({
      entries: [{ name: 'notes.md', kind: 'file', bytes: 11 }],
      truncated: false,
    });
    await expect(port.files.read(WORKSPACE, 'notes.md', 6, 100)).resolves.toMatchObject({
      content: 'world',
    });
    save.resolve('rev');
    await saving;
  });

  it('deletes a conversation so it is no longer listed', async () => {
    const harness = await setup();
    const thread = await harness.port.createThread(WORKSPACE, QWEN);
    expect(harness.port.threads().map((entry) => entry.id)).toContain(thread.id);

    await harness.port.deleteThread(thread.id);

    expect(harness.port.thread(thread.id)).toBeNull();
    expect(harness.port.threads().map((entry) => entry.id)).not.toContain(thread.id);
  });

  it('reports live reachability', async () => {
    const harness = await setup();
    expect(harness.port.network()).toBe('online');
    harness.network.set('offline');
    expect(harness.port.network()).toBe('offline');
  });
});
