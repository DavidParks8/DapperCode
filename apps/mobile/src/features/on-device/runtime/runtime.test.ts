import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';
import { randomUUID } from 'expo-crypto';
import { localModelDefinition } from '../models/catalog';
import type { LocalModelContext, LocalModelReply } from '../models/engine';
import { loadNativeModelContext } from '../models/engine';
import type { OnDeviceNativeServices } from '../native/services.types';
import { localChatControls } from '../screens/chatControls';
import { emptyLocalPreferences } from './preferences';
import { OnDeviceRuntime } from './runtime';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));
jest.mock('../models/expoDownloads', () => ({
  expoModelTransfers: { create: jest.fn(), restore: jest.fn() },
  modelResumeStorage: { read: jest.fn(async () => null), write: jest.fn(), remove: jest.fn() },
}));

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
    getGitTransferProgress: jest.fn(() => ({
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
    getDownloadedModelFile: jest.fn(async (id: string) => {
      const model = localModelDefinition(id);
      return { id, uri: `file:///models/${id}.gguf`, bytes: model.bytes, sha256: model.sha256 };
    }),
    finalizeModelDownload: jest.fn<
      ReturnType<OnDeviceNativeServices['finalizeModelDownload']>,
      Parameters<OnDeviceNativeServices['finalizeModelDownload']>
    >(),
    removeModelFile: jest.fn(async () => undefined),
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

test('failed preference loading cannot overwrite preserved data during backgrounding or disposal', async () => {
  const documents = new Map([['preferences.json', '{damaged']]);
  const h = harness(documents);
  await expect(h.runtime.initialize()).rejects.toThrow('preserved');
  await expect(h.runtime.background()).rejects.toThrow('have not loaded');
  await expect(h.runtime.dispose()).rejects.toThrow('have not loaded');
  expect(h.native.writeRuntimeDocument).not.toHaveBeenCalled();
  expect(documents.get('preferences.json')).toBe('{damaged');
});

test('backgrounding flushes drafts, unloads native context, and successful writes do not hide unrelated errors', async () => {
  const h = await ready();
  h.runtime.report(new Error('Earlier operation failed'));
  h.runtime.setDraft(h.thread.id, 'latest draft');
  await h.runtime.background();
  expect(h.context.release).toHaveBeenCalledTimes(1);
  expect(h.runtime.models.snapshot().phase).toBe('empty');
  expect(h.documents.get('preferences.json')).toContain('latest draft');
  expect(h.runtime.error()?.message).toBe('Earlier operation failed');
  const restored = harness(h.documents);
  await restored.runtime.initialize();
  expect(restored.runtime.draft(h.thread.id)).toBe('latest draft');
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

test('disposal is idempotent and still unloads when draft persistence fails', async () => {
  const h = await ready();
  h.native.writeRuntimeDocument.mockRejectedValueOnce(new Error('Disk full'));
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
  await h.runtime.deleteWorkspace('workspace-one');
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
  await expect(h.runtime.deleteWorkspace('workspace-two')).rejects.toThrow('settle');
  expect(h.native.deleteWorkspace).not.toHaveBeenCalled();
  blocker.resolve();
  await operation;
  await h.runtime.deleteWorkspace('workspace-two');
  expect(h.runtime.preferences().workspaceId).toBe('workspace-one');
  expect(h.runtime.workspaces().map((entry) => entry.id)).toEqual(['workspace-one']);
  await h.runtime.dispose();
});

test('renaming a workspace refreshes the listed name without changing the selection', async () => {
  const h = await ready();
  await expect(h.runtime.renameWorkspace('workspace-one', 'Renamed')).resolves.toMatchObject({
    id: 'workspace-one',
    name: 'Renamed',
  });
  expect(h.runtime.workspaces()).toEqual([
    { id: 'workspace-one', name: 'Renamed', isRepository: true },
  ]);
  expect(h.runtime.preferences().workspaceId).toBe('workspace-one');
  await h.runtime.dispose();
});
