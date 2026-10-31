import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';
import { randomUUID } from 'expo-crypto';
import { localModelDefinition } from '../models/catalog';
import type { LocalModelContext, LocalModelReply } from '../models/engine';
import { loadNativeModelContext } from '../models/engine';
import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalModelSessionSnapshot } from '../models/session';
import { retryableLocalMessages, type LocalRunSnapshot } from './agentLoop';
import { draftDocument } from './drafts';
import { COALESCED_EMIT_INTERVAL_MS } from './emitter';
import { OnDeviceOfflineError, type OnDeviceNetworkPort } from './network';
import { emptyLocalPreferences } from './preferences';
import { OnDeviceRuntime } from './runtime';
import { localAgentStatus, type LocalDownloadState } from './status';
import { THREAD_PROGRESS_SAVE_DELAY_MS } from './threads';
import type { LocalThread, OnDeviceReachability } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));

const modelId = 'qwen3-1.7b-q4-k-m';
const reply: LocalModelReply = {
  content: 'Finished',
  reasoning_content: '',
  tool_calls: [],
  interrupted: false,
  truncated: false,
  stopped_limit: 0,
  tokens_predicted: 5,
  tokens_evaluated: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function harness(documents = new Map<string, string>()) {
  const workspaces = [{ id: 'workspace-one', name: 'Workspace one', isRepository: true }];
  const native = {
    getAPIVersion: jest.fn(() => 7),
    cancelGitTransfer: jest.fn(),
    getGitTransferProgress: jest.fn<
      ReturnType<OnDeviceNativeServices['getGitTransferProgress']>,
      []
    >(() => ({
      active: false,
      cancelled: false,
      completed: 0,
      total: 0,
    })),
    getMemoryInfo: jest.fn(() => ({
      physicalBytes: 32 * 1024 ** 3,
      availableBytes: 16 * 1024 ** 3,
      isSimulator: true,
    })),
    readRuntimeDocument: jest.fn(async (name: string) => documents.get(name) ?? null),
    writeRuntimeDocument: jest.fn(async (name: string, value: string) => {
      documents.set(name, value);
    }),
    listRuntimeDocuments: jest.fn(async (prefix: string) =>
      [...documents.keys()].filter((key) => key.startsWith(prefix)),
    ),
    removeRuntimeDocument: jest.fn(async (name: string) => {
      documents.delete(name);
    }),
    storeGitCredential: jest.fn(async () => 'opaque-ref'),
    removeGitCredential: jest.fn(async () => undefined),
    listWorkspaces: jest.fn(async () => workspaces),
    createWorkspace: jest.fn(async (name: string) => ({
      id: 'created',
      name,
      isRepository: false,
    })),
    cloneWorkspace: jest.fn(async (name: string) => ({ id: 'cloned', name, isRepository: true })),
    renameWorkspace: jest.fn(async (id: string, name: string) => {
      const index = workspaces.findIndex((entry) => entry.id === id);
      const renamed = { id, name, isRepository: true };
      workspaces.splice(index, 1, renamed);
      return renamed;
    }),
    deleteWorkspace: jest.fn(async (id: string) => {
      workspaces.splice(
        workspaces.findIndex((entry) => entry.id === id),
        1,
      );
    }),
    getWorkspaceChangeToken: jest.fn(async () => 'token-0'),
    listWorkspaceFiles: jest.fn(async () => ({ entries: [], truncated: false })),
    readWorkspaceFile: jest.fn<
      ReturnType<OnDeviceNativeServices['readWorkspaceFile']>,
      Parameters<OnDeviceNativeServices['readWorkspaceFile']>
    >(async () => ({
      path: 'hello.txt',
      content: 'Native contents',
      revision: 'revision',
      nextOffset: null,
      totalBytes: 15,
    })),
    writeWorkspaceFile: jest.fn(async () => 'next-revision'),
    editWorkspaceFile: jest.fn(async () => 'next-revision'),
    renameWorkspacePath: jest.fn(async () => undefined),
    removeWorkspacePath: jest.fn(async () => undefined),
    renameWorkspaceEntry: jest.fn(async () => undefined),
    removeWorkspaceEntry: jest.fn(async () => undefined),
    searchWorkspaceFiles: jest.fn(async () => ({
      matches: [],
      truncated: false,
      skippedFiles: 0,
      visitedEntries: 0,
      searchedBytes: 0,
    })),
    getModelFilePaths: jest.fn(async () => ({
      partialUri: 'file:///partial',
      resumeUri: 'file:///resume',
      verificationBytes: null,
      availableBytes: 32 * 1024 ** 3,
    })),
    getDownloadedModelFile: jest.fn<
      ReturnType<OnDeviceNativeServices['getDownloadedModelFile']>,
      Parameters<OnDeviceNativeServices['getDownloadedModelFile']>
    >(async (id: string) => {
      const model = localModelDefinition(id);
      return { id, uri: `file:///models/${id}.gguf`, bytes: model.bytes, sha256: model.sha256 };
    }),
    finalizeModelDownload: jest.fn<
      ReturnType<OnDeviceNativeServices['finalizeModelDownload']>,
      Parameters<OnDeviceNativeServices['finalizeModelDownload']>
    >(),
    removeModelFile: jest.fn(async () => undefined),
    attachModelDownloads: jest.fn(async () => []),
    startModelDownload: jest.fn<
      ReturnType<OnDeviceNativeServices['startModelDownload']>,
      Parameters<OnDeviceNativeServices['startModelDownload']>
    >(),
    pauseModelDownload: jest.fn<
      ReturnType<OnDeviceNativeServices['pauseModelDownload']>,
      Parameters<OnDeviceNativeServices['pauseModelDownload']>
    >(),
    cancelModelDownload: jest.fn(async () => undefined),
    getModelDownload: jest.fn((id: string) => ({
      id,
      state: 'idle' as const,
      bytesWritten: 0,
      totalBytes: 0,
      resumable: false,
      interrupted: false,
      error: null,
    })),
    getModelVerificationProgress: jest.fn(() => ({ active: false, completed: 0, total: 0 })),
    cancelModelVerification: jest.fn(),
    getModelStorageInfo: jest.fn(async () => ({
      usedBytes: 0,
      freeBytes: 0,
      capacityBytes: 0,
      models: [],
    })),
    getWorkspaceGitStatus: jest.fn<
      ReturnType<OnDeviceNativeServices['getWorkspaceGitStatus']>,
      Parameters<OnDeviceNativeServices['getWorkspaceGitStatus']>
    >(),
    getWorkspaceGitDiff: jest.fn<
      ReturnType<OnDeviceNativeServices['getWorkspaceGitDiff']>,
      Parameters<OnDeviceNativeServices['getWorkspaceGitDiff']>
    >(),
    getWorkspaceGitHistory: jest.fn(async () => ({ commits: [] })),
    getWorkspaceGitBranches: jest.fn(async () => ({ branches: [] })),
    stageWorkspaceGit: jest.fn(async () => undefined),
    unstageWorkspaceGit: jest.fn(async () => undefined),
    commitWorkspaceGit: jest.fn(async () => 'commit-hash'),
    switchWorkspaceGitBranch: jest.fn(async () => undefined),
    createWorkspaceGitBranch: jest.fn(async () => undefined),
    discardWorkspaceGit: jest.fn(async () => undefined),
    initWorkspaceGit: jest.fn(async (id: string) => ({ id, name: id, isRepository: true })),
    fetchWorkspaceGit: jest.fn(async () => undefined),
    pullWorkspaceGit: jest.fn(async () => ({
      outcome: 'up-to-date' as const,
      from: 'a',
      to: 'a',
    })),
    getWorkspaceGitOrigin: jest.fn(async () => 'https://github.com/owner/repository.git'),
    pushWorkspaceGit: jest.fn(async () => undefined),
  } satisfies OnDeviceNativeServices;
  const context = {
    getFormattedChat: jest.fn(async (): Promise<FormattedChatResult> => ({
      type: 'jinja',
      prompt: 'prompt',
      has_media: false,
    })),
    tokenize: jest.fn(async () => ({ tokens: [1, 2] })),
    completion: jest.fn<
      Promise<LocalModelReply>,
      [CompletionParams, ((value: TokenData) => void)?]
    >(async () => reply),
    stopCompletion: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    isJinjaSupported: jest.fn(() => true),
  } satisfies LocalModelContext;
  jest.mocked(loadNativeModelContext).mockResolvedValue(context);
  return { documents, workspaces, native, context, runtime: new OnDeviceRuntime(native) };
}

beforeEach(() => {
  jest.clearAllMocks();
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

describe('public GitHub OAuth configuration', () => {
  const originalClientId = process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID;

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID;
    } else {
      process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID = originalClientId;
    }
    jest.restoreAllMocks();
  });

  test.each([
    [undefined, 'Ov23ctzKpdigHwQUbG8X'],
    [' public-build-override ', 'public-build-override'],
  ])(
    'the configured UI state and device request use the same client ID for %s',
    async (override, expected) => {
      if (override === undefined) {
        delete process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID;
      } else {
        process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID = override;
      }
      const request = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline test'));
      const h = harness();
      expect(h.runtime.authConfigured()).toBe(true);
      await expect(h.runtime.signIn(jest.fn())).rejects.toThrow();
      expect(request).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({ body: `client_id=${expected}&scope=repo` }),
      );
      expect(h.native.storeGitCredential).not.toHaveBeenCalled();
    },
  );

  test('an explicitly empty build override disables sign-in without making a request', async () => {
    process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID = '';
    const request = jest.spyOn(globalThis, 'fetch');
    const h = harness();
    expect(h.runtime.authConfigured()).toBe(false);
    await expect(h.runtime.signIn(jest.fn())).rejects.toThrow('not configured');
    expect(request).not.toHaveBeenCalled();
  });
});

async function ready() {
  const h = harness();
  await h.runtime.initialize();
  await h.runtime.selectWorkspace('workspace-one');
  await h.runtime.selectModel(modelId);
  const thread = await h.runtime.createThread();
  return { ...h, thread };
}

test('initialization is single-owner, preserves settings, and selecting a loaded model does not reload it', async () => {
  const h = harness();
  const first = h.runtime.initialize();
  expect(h.runtime.initialize()).toBe(first);
  await first;
  await h.runtime.selectModel(modelId);
  await h.runtime.selectModel(modelId);
  expect(loadNativeModelContext).toHaveBeenCalledTimes(1);
  expect(h.native.listWorkspaces).toHaveBeenCalledTimes(1);
  await h.runtime.dispose();
  expect(h.context.release).toHaveBeenCalledTimes(1);
});

test('damaged preferences are set aside with their bytes preserved and the mode still starts', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1234);
  const documents = new Map([['preferences.json', '{damaged']]);
  const h = harness(documents);
  await h.runtime.initialize();
  expect(documents.has('preferences.json')).toBe(false);
  expect(documents.get('quarantine-1234-preferences.json')).toBe('{damaged');
  expect(h.runtime.preferences()).toEqual(emptyLocalPreferences());
  expect(h.runtime.issues()).toEqual([
    expect.objectContaining({ kind: 'recovery', message: expect.stringContaining('set aside') }),
  ]);
  await h.runtime.selectWorkspace('workspace-one');
  expect(JSON.parse(documents.get('preferences.json') ?? '{}')).toMatchObject({
    workspaceId: 'workspace-one',
  });
  await h.runtime.dispose();
  jest.restoreAllMocks();
});

test('preferences that cannot be set aside start the mode but are never overwritten', async () => {
  const documents = new Map([['preferences.json', '{damaged']]);
  const h = harness(documents);
  h.native.writeRuntimeDocument.mockRejectedValueOnce(new Error('Disk full'));
  await h.runtime.initialize();
  expect(h.runtime.issues()[0]).toMatchObject({
    kind: 'recovery',
    message: expect.stringContaining('left in place'),
  });
  await h.runtime.background();
  await expect(h.runtime.selectWorkspace('workspace-one')).rejects.toThrow('left in place');
  await h.runtime.dispose();
  expect(documents.get('preferences.json')).toBe('{damaged');
});

test('backgrounding flushes history, unloads native context, and successful writes do not hide unrelated errors', async () => {
  const h = await ready();
  h.runtime.report(new Error('Earlier operation failed'));
  h.runtime.threads.change(h.thread.id, (thread) => ({ ...thread, title: 'Renamed' }));
  void h.runtime.threads.save(h.thread.id).catch(() => undefined);
  await h.runtime.background();
  expect(h.context.release).toHaveBeenCalledTimes(1);
  expect(h.runtime.models.snapshot().phase).toBe('empty');
  expect(h.documents.get(`thread-${h.thread.id}.json`)).toContain('Renamed');
  // Drafts belong to the shared composer; the runtime never writes draft documents.
  expect([...h.documents.keys()].some((name) => name.startsWith('draft-'))).toBe(false);
  expect(h.runtime.error()?.message).toBe('Earlier operation failed');
  const restored = harness(h.documents);
  await restored.runtime.initialize();
  expect(restored.runtime.legacyDrafts().size).toBe(0);
  expect(restored.runtime.threads.get(h.thread.id).workspaceId).toBe('workspace-one');
  await restored.runtime.dispose();
  await h.runtime.dispose();
});

test('background during a native tool waits for its result, preserves durable history, and settles all chat controls', async () => {
  const h = await ready();
  const started = deferred<void>();
  const result = deferred<Awaited<ReturnType<OnDeviceNativeServices['readWorkspaceFile']>>>();
  h.native.readWorkspaceFile.mockImplementation(() => {
    started.resolve();
    return result.promise;
  });
  h.context.completion.mockResolvedValueOnce({
    ...reply,
    content: '',
    tool_calls: [
      {
        id: 'call',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"hello.txt"}' },
      },
    ],
  });
  const running = h.runtime.sendMessage(h.thread.id, 'Read hello.txt', 'submission', jest.fn());
  await started.promise;
  const controls = () =>
    localChatControls(
      h.runtime.threads.get(h.thread.id),
      h.runtime.loop.snapshot(),
      h.runtime.models.snapshot(),
      h.runtime.workspaceActivity(),
    );
  expect(controls()).toMatchObject({
    isLoading: true,
    showStopButton: true,
    submitDisabled: true,
    status: 'Running read_file',
  });
  const background = h.runtime.background();
  expect(controls()).toMatchObject({ isStopping: true, isLoading: true, submitDisabled: true });
  expect(h.context.release).not.toHaveBeenCalled();
  result.resolve({
    path: 'hello.txt',
    content: 'Native contents',
    revision: 'revision',
    nextOffset: null,
    totalBytes: 15,
  });
  await background;
  await running;
  expect(controls()).toMatchObject({
    isStopping: false,
    isLoading: false,
    showStopButton: false,
    submitDisabled: false,
  });
  expect(controls().status).toContain('completed edits are preserved');
  expect(h.runtime.threads.get(h.thread.id)).toMatchObject({
    status: 'interrupted',
    activeTurnId: null,
  });
  expect(h.context.completion).toHaveBeenCalledTimes(1);
  expect(h.context.release).toHaveBeenCalledTimes(1);
  await h.runtime.dispose();
});

test('manual workspace operations exclude generation and background waits before flushing and releasing ownership', async () => {
  const h = await ready();
  const completion = deferred<void>();
  const operation = h.runtime.workspaceTask('Pushing', () => completion.promise);
  expect(h.runtime.workspaceActivity()).toBe('Pushing');
  await expect(
    h.runtime.sendMessage(h.thread.id, 'hello', 'submission', jest.fn()),
  ).rejects.toThrow('settle');
  let settled = false;
  const background = h.runtime.background().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  completion.resolve();
  await operation;
  await background;
  expect(h.runtime.workspaceActivity()).toBeNull();
  expect(settled).toBe(true);
  await h.runtime.dispose();
});

test('disposal is idempotent and still unloads when history persistence fails', async () => {
  const h = await ready();
  h.native.writeRuntimeDocument.mockRejectedValueOnce(new Error('Disk full'));
  h.runtime.threads.change(h.thread.id, (thread) => ({ ...thread, title: 'Unsaved' }));
  void h.runtime.threads.save(h.thread.id).catch(() => undefined);
  const disposal = h.runtime.dispose();
  expect(h.runtime.dispose()).toBe(disposal);
  await expect(disposal).rejects.toThrow('Disk full');
  expect(h.context.release).toHaveBeenCalledTimes(1);
  expect(h.runtime.models.snapshot().phase).toBe('empty');
});

test('deleting the selected download unloads it and clears the new-conversation default without deleting history', async () => {
  const h = await ready();
  await h.runtime.removeModel(modelId);
  expect(h.context.release).toHaveBeenCalledTimes(1);
  expect(h.native.removeModelFile).toHaveBeenCalledWith(modelId);
  expect(h.runtime.preferences().modelId).toBeNull();
  expect(h.runtime.threads.get(h.thread.id).modelId).toBe(modelId);
  await expect(h.runtime.createThread()).rejects.toThrow('downloaded model');
  await h.runtime.dispose();
});

test('Git account credentials are origin-bound and author settings survive a new owner', async () => {
  const h = harness(
    new Map([
      [
        'preferences.json',
        JSON.stringify({
          ...emptyLocalPreferences(),
          account: {
            providerId: 'github',
            host: 'github.com',
            id: '123',
            login: 'author',
            credentialRef: 'opaque-ref',
          },
        }),
      ],
    ]),
  );
  await h.runtime.initialize();
  expect(await h.runtime.credential('workspace-one')).toBe('opaque-ref');
  h.native.getWorkspaceGitOrigin.mockResolvedValueOnce('https://other.example/repo.git');
  await expect(h.runtime.credential('workspace-one')).rejects.toThrow();
  await h.runtime.saveAuthor({ name: ' Offline Author ', email: ' author@example.invalid ' });
  await h.runtime.signOut();
  expect(h.native.removeGitCredential).toHaveBeenCalledWith('opaque-ref');
  expect(h.runtime.preferences()).toMatchObject({
    account: null,
    author: { name: 'Offline Author', email: 'author@example.invalid' },
  });
  await h.runtime.dispose();
});

test('deleting the selected workspace clears the new-conversation default but keeps its conversations readable', async () => {
  const h = await ready();
  await h.runtime.workspaceAdmin.delete('workspace-one');
  expect(h.native.deleteWorkspace).toHaveBeenCalledWith('workspace-one');
  expect(h.runtime.workspaces()).toEqual([]);
  expect(h.runtime.preferences().workspaceId).toBeNull();
  expect(JSON.parse(h.documents.get('preferences.json') ?? '{}')).toMatchObject({
    workspaceId: null,
  });
  expect(h.runtime.threads.get(h.thread.id)).toMatchObject({ workspaceId: 'workspace-one' });
  expect(h.runtime.workspaceActivity()).toBeNull();
  await expect(h.runtime.createThread()).rejects.toThrow('local workspace');
  await h.runtime.dispose();
});

test('deleting another workspace keeps the selection, and workspaces cannot be deleted mid-operation', async () => {
  const h = await ready();
  h.workspaces.push({ id: 'workspace-two', name: 'Workspace two', isRepository: false });
  const blocker = deferred<void>();
  const operation = h.runtime.workspaceTask('Pushing', () => blocker.promise);
  await expect(h.runtime.workspaceAdmin.delete('workspace-two')).rejects.toThrow('settle');
  expect(h.native.deleteWorkspace).not.toHaveBeenCalled();
  blocker.resolve();
  await operation;
  await h.runtime.workspaceAdmin.delete('workspace-two');
  expect(h.runtime.preferences().workspaceId).toBe('workspace-one');
  expect(h.runtime.workspaces().map((entry) => entry.id)).toEqual(['workspace-one']);
  await h.runtime.dispose();
});

test('renaming a workspace refreshes the listed name without changing the selection', async () => {
  const h = await ready();
  await expect(h.runtime.workspaceAdmin.rename('workspace-one', 'Renamed')).resolves.toMatchObject({
    id: 'workspace-one',
    name: 'Renamed',
  });
  expect(h.runtime.workspaces()).toEqual([
    { id: 'workspace-one', name: 'Renamed', isRepository: true },
  ]);
  expect(h.runtime.preferences().workspaceId).toBe('workspace-one');
  await h.runtime.dispose();
});

function fakeNetwork(initial: OnDeviceReachability) {
  let listener: ((value: OnDeviceReachability) => void) | null = null;
  return {
    port: {
      current: jest.fn(async () => initial),
      subscribe: jest.fn((next: (value: OnDeviceReachability) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      }),
    } satisfies OnDeviceNetworkPort,
    change: (value: OnDeviceReachability) => listener?.(value),
  };
}

const otherModelId = 'qwen3-0.6b-q4-0';

describe('lifecycle', () => {
  test('backgrounding unloads without pausing downloads; returning warms the model and resumes interrupted downloads', async () => {
    const h = await ready();
    const pause = jest.spyOn(h.runtime.downloads, 'pause');
    const pauseAll = jest.spyOn(h.runtime.downloads, 'pauseAll');
    const resume = jest
      .spyOn(h.runtime.downloads, 'resumeLifecyclePaused')
      .mockResolvedValue(undefined);
    await h.runtime.background();
    expect(h.runtime.models.snapshot().phase).toBe('empty');
    expect(pause).not.toHaveBeenCalled();
    expect(pauseAll).not.toHaveBeenCalled();
    await h.runtime.foreground();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(loadNativeModelContext).toHaveBeenCalledTimes(2);
    expect(h.runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId });
    expect(h.context.completion).not.toHaveBeenCalled();
    await h.runtime.dispose();
  });

  test('returning does not warm a model that memory admission would refuse', async () => {
    const h = await ready();
    await h.runtime.background();
    h.native.getMemoryInfo.mockReturnValue({
      physicalBytes: 32 * 1024 ** 3,
      availableBytes: 64 * 1024 ** 2,
      isSimulator: true,
    });
    await h.runtime.foreground();
    expect(loadNativeModelContext).toHaveBeenCalledTimes(1);
    expect(h.runtime.models.snapshot()).toMatchObject({ phase: 'empty', error: null });
    await h.runtime.dispose();
  });

  test('interrupted downloads resume only once the network is back', async () => {
    const network = fakeNetwork('online');
    const h = harness();
    const runtime = new OnDeviceRuntime(h.native, { network: network.port });
    await runtime.initialize();
    const resume = jest
      .spyOn(runtime.downloads, 'resumeLifecyclePaused')
      .mockResolvedValue(undefined);
    await runtime.background();
    network.change('offline');
    await runtime.foreground();
    expect(resume).not.toHaveBeenCalled();
    network.change('online');
    expect(resume).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  test('disposal stops download polling without pausing the background transfers', async () => {
    const h = await ready();
    const dispose = jest.spyOn(h.runtime.downloads, 'dispose');
    const pauseAll = jest.spyOn(h.runtime.downloads, 'pauseAll');
    await h.runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pauseAll).not.toHaveBeenCalled();
  });

  test('a memory warning unloads the model without pausing downloads or warming it later', async () => {
    const h = await ready();
    const pause = jest.spyOn(h.runtime.downloads, 'pause');
    await h.runtime.relieveMemory();
    expect(h.runtime.models.snapshot().phase).toBe('empty');
    expect(pause).not.toHaveBeenCalled();
    await h.runtime.foreground();
    expect(loadNativeModelContext).toHaveBeenCalledTimes(1);
    await h.runtime.dispose();
  });
});

describe('unrelated actions never interrupt a running conversation', () => {
  async function running() {
    const h = await ready();
    const generated = deferred<LocalModelReply>();
    const started = deferred<void>();
    h.context.completion.mockImplementationOnce(() => {
      started.resolve();
      return generated.promise;
    });
    const run = h.runtime.sendMessage(h.thread.id, 'hello', 'submission', jest.fn());
    await started.promise;
    const other = await h.runtime.threads.create('workspace-one', modelId);
    const finish = async () => {
      generated.resolve(reply);
      return run;
    };
    return { ...h, other, finish };
  }

  test('selecting the loaded model for another conversation, the workspace, and signing out keep the run going', async () => {
    const h = await running();
    await h.runtime.selectModel(modelId, h.other.id);
    await h.runtime.selectWorkspace('workspace-one', h.other.id);
    await h.runtime.signOut();
    expect(h.context.stopCompletion).not.toHaveBeenCalled();
    expect(h.native.cancelGitTransfer).not.toHaveBeenCalled();
    expect((await h.finish()).status).toBe('complete');
    await h.runtime.dispose();
  });

  test('choosing another model for an idle conversation keeps the run going and loads nothing', async () => {
    const h = await running();
    const loads = jest.mocked(loadNativeModelContext).mock.calls.length;
    await h.runtime.chooseModel(otherModelId, h.other.id);
    expect(h.runtime.threads.get(h.other.id).modelId).toBe(otherModelId);
    expect(h.runtime.preferences().modelId).toBe(otherModelId);
    expect(jest.mocked(loadNativeModelContext).mock.calls).toHaveLength(loads);
    expect(h.runtime.models.snapshot().modelId).toBe(modelId);
    await expect(h.runtime.chooseModel(otherModelId, h.thread.id)).rejects.toThrow(
      'Stop this conversation',
    );
    expect(h.runtime.threads.get(h.thread.id).modelId).toBe(modelId);
    expect(h.context.stopCompletion).not.toHaveBeenCalled();
    expect((await h.finish()).status).toBe('complete');
    await h.runtime.dispose();
  });

  test('removing an unrelated download does not stop the run', async () => {
    const h = await running();
    await h.runtime.removeModel(otherModelId);
    expect(h.native.removeModelFile).toHaveBeenCalledWith(otherModelId);
    expect(h.context.stopCompletion).not.toHaveBeenCalled();
    expect((await h.finish()).status).toBe('complete');
    await h.runtime.dispose();
  });

  test('actions that would affect the run are rejected with a clear error instead of stopping it', async () => {
    const h = await running();
    await expect(h.runtime.selectModel(otherModelId, h.other.id)).rejects.toThrow(
      'conversation is running',
    );
    await expect(h.runtime.selectModel(otherModelId, h.thread.id)).rejects.toThrow(
      'Stop this conversation',
    );
    await expect(h.runtime.removeModel(modelId)).rejects.toThrow('Stop the running');
    await expect(h.runtime.unloadModel()).rejects.toThrow('Stop the running');
    h.native.getGitTransferProgress.mockReturnValueOnce({
      active: true,
      cancelled: false,
      completed: 1,
      total: 2,
    });
    await expect(h.runtime.signOut()).rejects.toThrow('Git transfer');
    expect(h.context.stopCompletion).not.toHaveBeenCalled();
    expect(h.native.removeModelFile).not.toHaveBeenCalled();
    expect((await h.finish()).status).toBe('complete');
    await h.runtime.dispose();
  });
});

describe('fail-open startup', () => {
  const damagedId = '00000000-0000-4000-8000-00000000dead';

  test('damaged and unexpected conversation files are set aside and the rest of the mode starts', async () => {
    const source = await ready();
    await source.runtime.dispose();
    const documents = new Map(source.documents);
    documents.set(`thread-${damagedId}.json`, '{not json');
    documents.set('thread-unexpected.json', '{"id":"unexpected"}');
    const h = harness(documents);
    await h.runtime.initialize();
    expect(h.runtime.threads.list().map((thread) => thread.id)).toEqual([source.thread.id]);
    const quarantined = [...documents.entries()].filter(([name]) => name.startsWith('quarantine-'));
    expect(quarantined.map(([, value]) => value).sort()).toEqual([
      '{"id":"unexpected"}',
      '{not json',
    ]);
    expect(documents.has(`thread-${damagedId}.json`)).toBe(false);
    expect(h.runtime.issues()).toEqual([
      expect.objectContaining({
        kind: 'recovery',
        message: '2 damaged local conversations were set aside with their data preserved.',
      }),
    ]);
    expect(h.runtime.preferences().modelId).toBe(modelId);
    await h.runtime.dispose();
  });

  test('a conversation file that cannot be read is skipped and left in place', async () => {
    const documents = new Map([[`thread-${damagedId}.json`, 'unreadable']]);
    const h = harness(documents);
    h.native.readRuntimeDocument.mockImplementation(async (name: string) => {
      if (name.startsWith('thread-')) {
        throw new Error('Local runtime documents must be regular files no larger than 8 MiB.');
      }
      return documents.get(name) ?? null;
    });
    await h.runtime.initialize();
    expect(h.runtime.threads.list()).toEqual([]);
    expect(documents.get(`thread-${damagedId}.json`)).toBe('unreadable');
    expect(h.runtime.issues()[0]?.message).toContain('left in place');
    await h.runtime.dispose();
  });
});

describe('typed issues', () => {
  test('a failed conversation write is a retryable persistence issue that clears after retry', async () => {
    const h = await ready();
    h.native.writeRuntimeDocument.mockRejectedValueOnce(new Error('Disk full'));
    h.runtime.threads.change(h.thread.id, (thread) => ({ ...thread, title: 'Renamed' }));
    await expect(h.runtime.threads.save(h.thread.id)).rejects.toThrow('Disk full');
    h.runtime.report(new Error('Transient failure'));
    expect(h.runtime.issues()).toEqual([
      expect.objectContaining({
        id: `persistence:thread:${h.thread.id}`,
        kind: 'persistence',
        retryable: true,
        threadId: h.thread.id,
      }),
      expect.objectContaining({
        kind: 'operation',
        message: 'Transient failure',
        retryable: false,
      }),
    ]);
    expect(h.runtime.issues()).toBe(h.runtime.issues());
    await h.runtime.retryPersistence();
    expect(h.runtime.issues().map((issue) => issue.kind)).toEqual(['operation']);
    h.runtime.dismissIssue(h.runtime.issues()[0]?.id ?? '');
    expect(h.runtime.issues()).toEqual([]);
    await h.runtime.dispose();
  });

  test('a stale conversation error can be dismissed and stays cleared after a restart', async () => {
    const h = await ready();
    h.context.completion.mockRejectedValueOnce(new Error('Model failed'));
    await expect(
      h.runtime.sendMessage(h.thread.id, 'hello', 'submission', jest.fn()),
    ).rejects.toThrow('Model failed');
    h.runtime.report(new Error('Model failed'), h.thread.id);
    expect(h.runtime.threads.get(h.thread.id).lastError).toBe('Model failed');
    await h.runtime.dismissThreadError(h.thread.id);
    expect(h.runtime.threads.get(h.thread.id).lastError).toBeNull();
    expect(h.runtime.issues()).toEqual([]);
    await h.runtime.dispose();
    const restored = harness(h.documents);
    await restored.runtime.initialize();
    expect(restored.runtime.threads.get(h.thread.id).lastError).toBeNull();
    await restored.runtime.dispose();
  });
});

describe('network awareness', () => {
  test('offline clone, push, sign-in, and download fail fast with a friendly message', async () => {
    const network = fakeNetwork('offline');
    const h = harness();
    const fetch = jest.spyOn(globalThis, 'fetch');
    const runtime = new OnDeviceRuntime(h.native, { network: network.port });
    const listener = jest.fn();
    runtime.subscribe(listener, ['network']);
    await runtime.initialize();
    expect(runtime.network()).toBe('offline');
    expect(listener).toHaveBeenCalled();
    await expect(runtime.cloneWorkspace('repo', 'https://github.com/o/r.git')).rejects.toThrow(
      OnDeviceOfflineError,
    );
    await expect(runtime.pushWorkspace('workspace-one')).rejects.toThrow("You're offline");
    await expect(runtime.signIn(jest.fn())).rejects.toThrow('sign in to GitHub');
    await expect(runtime.downloadModel(otherModelId)).rejects.toThrow('download models');
    expect(h.native.cloneWorkspace).not.toHaveBeenCalled();
    expect(h.native.pushWorkspaceGit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    network.change('online');
    expect(runtime.network()).toBe('online');
    await runtime.pushWorkspace('workspace-one');
    expect(h.native.pushWorkspaceGit).toHaveBeenCalledWith('workspace-one', null);
    await runtime.dispose();
    jest.restoreAllMocks();
  });
});

describe('persistence volume', () => {
  test('inline drafts from older builds are offered for import for existing conversations only, and never rewritten', async () => {
    const source = await ready();
    await source.runtime.dispose();
    const documents = new Map(source.documents);
    documents.set(
      'preferences.json',
      JSON.stringify({
        ...JSON.parse(documents.get('preferences.json') ?? '{}'),
        drafts: { [source.thread.id]: 'legacy draft', 'deleted-thread': 'orphan' },
      }),
    );
    const h = harness(documents);
    await h.runtime.initialize();
    expect([...h.runtime.legacyDrafts()]).toEqual([[source.thread.id, 'legacy draft']]);
    expect(documents.has(draftDocument(source.thread.id))).toBe(false);
    // The orphan is obsolete; the live draft stays until the composer confirms its import.
    expect(JSON.parse(documents.get('preferences.json') ?? '{}')).toMatchObject({
      drafts: { [source.thread.id]: 'legacy draft' },
    });
    await h.runtime.settleLegacyDrafts(new Map([[source.thread.id, 'imported']]));
    expect(h.runtime.legacyDrafts().size).toBe(0);
    expect(JSON.parse(documents.get('preferences.json') ?? '{}')).toMatchObject({ drafts: {} });
    await h.runtime.dispose();
  });

  test('draft documents from older builds are removed only once imported, or set aside when superseded', async () => {
    const source = await ready();
    const second = await source.runtime.createThread();
    await source.runtime.dispose();
    const documents = new Map(source.documents);
    documents.set(draftDocument(source.thread.id), JSON.stringify({ version: 1, text: 'one' }));
    documents.set(draftDocument(second.id), JSON.stringify({ version: 1, text: 'two' }));
    const h = harness(documents);
    await h.runtime.initialize();
    expect(Object.fromEntries(h.runtime.legacyDrafts())).toEqual({
      [source.thread.id]: 'one',
      [second.id]: 'two',
    });
    await h.runtime.settleLegacyDrafts(
      new Map([
        [source.thread.id, 'imported'],
        [second.id, 'superseded'],
      ]),
    );
    expect(documents.has(draftDocument(source.thread.id))).toBe(false);
    expect(documents.has(draftDocument(second.id))).toBe(false);
    const setAside = [...documents].filter(([name]) => name.startsWith('quarantine-'));
    expect(setAside).toEqual([
      [expect.stringContaining(second.id), JSON.stringify({ version: 1, text: 'two' })],
    ]);
    expect(h.runtime.issues()).toEqual([
      expect.objectContaining({
        kind: 'recovery',
        message: expect.stringContaining('newer draft'),
      }),
    ]);
    await h.runtime.dispose();
    const restored = harness(documents);
    await restored.runtime.initialize();
    expect(restored.runtime.legacyDrafts().size).toBe(0);
    await restored.runtime.dispose();
  });

  test('deleting a conversation prunes its legacy draft', async () => {
    const source = await ready();
    await source.runtime.dispose();
    const documents = new Map(source.documents);
    documents.set(draftDocument(source.thread.id), JSON.stringify({ version: 1, text: 'pending' }));
    const h = harness(documents);
    await h.runtime.initialize();
    expect(h.runtime.legacyDrafts().get(source.thread.id)).toBe('pending');
    await h.runtime.deleteThread(source.thread.id);
    expect(documents.has(draftDocument(source.thread.id))).toBe(false);
    expect(h.runtime.legacyDrafts().size).toBe(0);
    await h.runtime.dispose();
  });

  test('a turn journals the user message immediately and coalesces progress into one later write', async () => {
    jest.useFakeTimers();
    try {
      const h = await ready();
      const name = `thread-${h.thread.id}.json`;
      const threadWrites = () =>
        h.native.writeRuntimeDocument.mock.calls.filter(([document]) => document === name);
      h.native.writeRuntimeDocument.mockClear();
      await h.runtime.sendMessage(h.thread.id, 'hello', 'submission', jest.fn());
      expect(threadWrites()).toHaveLength(1);
      expect(JSON.parse(threadWrites()[0]?.[1] ?? '{}')).toMatchObject({ status: 'running' });
      await jest.advanceTimersByTimeAsync(THREAD_PROGRESS_SAVE_DELAY_MS);
      expect(threadWrites()).toHaveLength(2);
      expect(JSON.parse(h.documents.get(name) ?? '{}')).toMatchObject({
        status: 'complete',
        messages: [{ role: 'user' }, { role: 'assistant', content: 'Finished' }],
      });
      await h.runtime.dispose();
      expect(threadWrites()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('render granularity', () => {
  test('token streaming notifies thread subscribers at most once per interval and never download subscribers', async () => {
    jest.useFakeTimers();
    try {
      const h = await ready();
      const threads = jest.fn();
      const downloads = jest.fn();
      h.runtime.subscribe(threads, ['threads']);
      h.runtime.subscribe(downloads, ['downloads']);
      const generated = deferred<LocalModelReply>();
      let stream: ((value: TokenData) => void) | undefined;
      h.context.completion.mockImplementationOnce((_params, callback) => {
        stream = callback;
        return generated.promise;
      });
      const run = h.runtime.sendMessage(h.thread.id, 'hello', 'submission', jest.fn());
      while (!stream) {
        await jest.advanceTimersByTimeAsync(1);
      }
      threads.mockClear();
      let text = '';
      for (let index = 0; index < 100; index += 1) {
        text += 'x';
        stream({ token: 'x', accumulated_text: text, content: text });
      }
      expect(threads.mock.calls.length).toBeLessThanOrEqual(1);
      await jest.advanceTimersByTimeAsync(COALESCED_EMIT_INTERVAL_MS);
      expect(threads.mock.calls.length).toBeLessThanOrEqual(2);
      expect(h.runtime.threads.get(h.thread.id).messages.at(-1)?.content).toBe(text);
      generated.resolve(reply);
      await run;
      expect(downloads).not.toHaveBeenCalled();
      await h.runtime.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('disposal during startup', () => {
  test('waits for initialization, registers no network listener, and skips later startup work', async () => {
    const network = fakeNetwork('online');
    const h = harness();
    const listing = deferred<string[]>();
    h.native.listRuntimeDocuments.mockImplementationOnce(() => listing.promise);
    const runtime = new OnDeviceRuntime(h.native, { network: network.port });
    const initializing = runtime.initialize();
    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve();
    }
    expect(disposed).toBe(false);
    listing.resolve([]);
    await initializing;
    await disposal;
    expect(network.port.subscribe).not.toHaveBeenCalled();
    expect(h.native.listWorkspaces).not.toHaveBeenCalled();
    expect(h.native.listRuntimeDocuments).not.toHaveBeenCalledWith('draft-');
  });
});

describe('legacy inline drafts are kept until the composer confirms them', () => {
  async function legacyDocuments() {
    const source = await ready();
    await source.runtime.dispose();
    const documents = new Map(source.documents);
    documents.set(
      'preferences.json',
      JSON.stringify({
        ...JSON.parse(documents.get('preferences.json') ?? '{}'),
        drafts: { [source.thread.id]: 'legacy draft' },
      }),
    );
    return { documents, id: source.thread.id };
  }
  const storedDrafts = (documents: Map<string, string>): unknown =>
    JSON.parse(documents.get('preferences.json') ?? '{}').drafts;

  test('a draft for a conversation that could not be read this launch is kept, not erased', async () => {
    const { documents, id } = await legacyDocuments();
    const h = harness(documents);
    const read = h.native.readRuntimeDocument.getMockImplementation();
    h.native.readRuntimeDocument.mockImplementation(async (name: string) => {
      if (name.startsWith('thread-')) {
        throw new Error('Temporarily unreadable.');
      }
      return (await read?.(name)) ?? null;
    });
    await h.runtime.initialize();
    expect(h.runtime.threads.list()).toEqual([]);
    expect(h.runtime.legacyDrafts().size).toBe(0);
    await h.runtime.selectWorkspace('workspace-one');
    expect(storedDrafts(documents)).toEqual({ [id]: 'legacy draft' });
    await h.runtime.dispose();
  });

  test('a failed draft restore keeps legacy drafts through later settings saves', async () => {
    const { documents, id } = await legacyDocuments();
    const h = harness(documents);
    const list = h.native.listRuntimeDocuments.getMockImplementation();
    h.native.listRuntimeDocuments.mockImplementation(async (prefix: string) => {
      if (prefix === 'draft-') {
        throw new Error('Draft listing failed.');
      }
      return (await list?.(prefix)) ?? [];
    });
    await h.runtime.initialize();
    await h.runtime.selectWorkspace('workspace-one');
    await h.runtime.dispose();
    expect(storedDrafts(documents)).toEqual({ [id]: 'legacy draft' });
    expect(documents.has(draftDocument(id))).toBe(false);
  });

  test('a failed settle keeps the legacy draft so the import is retried', async () => {
    const { documents, id } = await legacyDocuments();
    const h = harness(documents);
    await h.runtime.initialize();
    h.native.writeRuntimeDocument.mockRejectedValueOnce(new Error('Disk full'));
    await expect(h.runtime.settleLegacyDrafts(new Map([[id, 'imported']]))).rejects.toThrow(
      'Disk full',
    );
    expect(storedDrafts(documents)).toEqual({ [id]: 'legacy draft' });
    expect(h.runtime.issues()).toEqual([
      expect.objectContaining({ id: 'persistence:preferences', retryable: true }),
    ]);
    await h.runtime.retryPersistence();
    expect(storedDrafts(documents)).toEqual({});
    await h.runtime.dispose();
  });
});

/**
 * The chat controls a runtime snapshot implies (busy, stop, submit, retry, and status). Asserting
 * them after each transition proves the runtime never leaves a settled turn looking busy.
 */
function localChatControls(
  thread: LocalThread,
  run: LocalRunSnapshot,
  model: LocalModelSessionSnapshot,
  workspaceActivity: string | null,
  download?: LocalDownloadState | null,
) {
  const active = run.phase !== 'idle';
  const ownRun = active && run.threadId === thread.id;
  const loading = model.phase === 'loading';
  const status = localAgentStatus({
    run,
    model,
    thread,
    modelId: thread.modelId,
    workspaceActivity,
    ...(download === undefined ? {} : { download }),
  });
  return {
    isLoading: active || loading,
    isStopping: ownRun && run.phase === 'stopping',
    showStopButton: ownRun,
    submitDisabled: active || loading || Boolean(workspaceActivity) || status.blocking,
    status: status.label,
    statusKind: status.kind,
    statusDetail: status.detail,
    progress: status.progress,
    approval: ownRun ? run.approval : null,
    canRetry: !active && !workspaceActivity && retryableLocalMessages(thread) !== null,
  };
}

function controlsFor(h: Awaited<ReturnType<typeof ready>>) {
  return localChatControls(
    h.runtime.threads.get(h.thread.id),
    h.runtime.loop.snapshot(),
    h.runtime.models.snapshot(),
    h.runtime.workspaceActivity(),
    h.runtime.downloads.snapshot(modelId),
  );
}

async function settle(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

test('Stop during a model load settles the turn promptly, shows load progress, and keeps the draft', async () => {
  const h = await ready();
  await h.runtime.models.unload();
  const pending = deferred<LocalModelContext>();
  jest.mocked(loadNativeModelContext).mockImplementationOnce(async (_m, _f, _o, progress) => {
    progress(37);
    return pending.promise;
  });
  const accepted = jest.fn();
  const running = h.runtime.sendMessage(h.thread.id, 'Hello', 'submission', accepted);
  await settle(() => h.runtime.models.snapshot().progress === 37);
  expect(controlsFor(h)).toMatchObject({
    status: 'Loading Qwen3 1.7B Q4_K_M · 37%',
    progress: 37,
    showStopButton: true,
  });
  await h.runtime.stop();
  await running;
  expect(accepted).not.toHaveBeenCalled();
  expect(h.runtime.threads.get(h.thread.id).messages).toHaveLength(0);
  expect(controlsFor(h)).toMatchObject({ showStopButton: false, isLoading: false });
  const late = { ...h.context, release: jest.fn(async () => undefined) };
  pending.resolve(late);
  await settle(() => h.runtime.models.snapshot().phase === 'empty');
  expect(late.release).toHaveBeenCalledTimes(1);
  await h.runtime.dispose();
});

test('a model that fails to load is reported as an error, never as ready', async () => {
  const h = await ready();
  await h.runtime.models.unload();
  h.native.getDownloadedModelFile.mockResolvedValueOnce(null);
  await expect(
    h.runtime.sendMessage(h.thread.id, 'Hello', 'submission', jest.fn()),
  ).rejects.toThrow('Download and verify');
  const controls = controlsFor(h);
  expect(controls).toMatchObject({
    status: "Couldn't load Qwen3 1.7B Q4_K_M",
    statusKind: 'error',
    statusDetail: 'Download and verify this catalog model before loading it.',
    canRetry: false,
  });
  expect(controls.status).not.toMatch(/ready/i);
  await h.runtime.dispose();
});

test('a model-initiated push waits for approval and a decline never reaches the network', async () => {
  const h = await ready();
  h.context.completion.mockResolvedValueOnce({
    ...reply,
    content: '',
    tool_calls: [{ id: 'push', type: 'function', function: { name: 'git_push', arguments: '{}' } }],
  });
  const running = h.runtime.sendMessage(h.thread.id, 'Push my work', 'submission', jest.fn());
  await settle(() => h.runtime.loop.snapshot().phase === 'approval');
  const controls = controlsFor(h);
  expect(controls.status).toBe('Waiting for your approval · Push the current branch to its remote');
  expect(controls.approval).toMatchObject({ toolName: 'git_push' });
  h.runtime.loop.resolveApproval(controls.approval!.callId, false);
  await running;
  expect(h.native.pushWorkspaceGit).not.toHaveBeenCalled();
  expect(h.runtime.threads.get(h.thread.id).status).toBe('complete');
  await h.runtime.dispose();
});

test('a failed turn can be retried through the runtime without resending the message', async () => {
  const h = await ready();
  h.context.completion.mockRejectedValueOnce(new Error('Decode failed'));
  await expect(
    h.runtime.sendMessage(h.thread.id, 'Explain', 'submission', jest.fn()),
  ).rejects.toThrow('Decode failed');
  expect(controlsFor(h)).toMatchObject({ canRetry: true, status: 'Local turn failed' });
  expect(h.runtime.models.snapshot().phase).toBe('ready');
  const retried = await h.runtime.retryTurn(h.thread.id);
  expect(retried.status).toBe('complete');
  expect(retried.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  expect(loadNativeModelContext).toHaveBeenCalledTimes(1);
  await h.runtime.dispose();
});

test('retrying a failed turn waits for a pending model unload instead of racing it', async () => {
  const h = await ready();
  h.context.completion.mockRejectedValueOnce(new Error('Decode failed'));
  await expect(
    h.runtime.sendMessage(h.thread.id, 'Explain', 'submission', jest.fn()),
  ).rejects.toThrow('Decode failed');
  const release = deferred<undefined>();
  h.context.release.mockImplementationOnce(() => release.promise);
  const unloading = h.runtime.unloadModel();
  await settle(() => h.runtime.models.snapshot().phase === 'stopping');
  const retried = h.runtime.retryTurn(h.thread.id);
  await Promise.resolve();
  expect(h.runtime.loop.snapshot().phase).toBe('idle');
  release.resolve(undefined);
  await unloading;
  await expect(retried).resolves.toMatchObject({ status: 'complete' });
  expect(loadNativeModelContext).toHaveBeenCalledTimes(2);
  expect(controlsFor(h)).toMatchObject({ canRetry: false, showStopButton: false });
  await h.runtime.dispose();
});
