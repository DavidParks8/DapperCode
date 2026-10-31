/* eslint-disable @typescript-eslint/require-await -- the fakes mirror async native APIs */
import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';

import { localModelDefinition } from '../models/catalog';
import type { NativeModelTransfer } from '../models/downloadState';
import type { LocalContextLoader, LocalModelContext, LocalModelReply } from '../models/engine';
import { residentModelBytes } from '../models/memory';
import type { LocalModelFile } from '../models/types';
import { OnDeviceNativeError } from '../native/services.errors';
import {
  ON_DEVICE_NATIVE_API_VERSION,
  type NativeGitTransferProgress,
  type OnDeviceNativeServices,
} from '../native/services.types';
import type { LocalGitStatus, LocalWorkspace } from '../workspaces/types';
import type { OnDeviceNetworkPort } from './network';
import { parseLocalThreadBase, threadDocument } from './threadCodec';
import {
  applyLocalThreadDelta,
  parseLocalThreadSegment,
  threadSegmentDocument,
} from './threadJournal';
import type { LocalThread, OnDeviceReachability } from './types';

const MiB = 1024 * 1024;

/** The durable state of a conversation: its base document plus contiguous journal segments. */
export function storedLocalThread(
  documents: ReadonlyMap<string, string>,
  id: string,
): LocalThread | null {
  const raw = documents.get(threadDocument(id));
  if (raw === undefined) {
    return null;
  }
  const base = parseLocalThreadBase(raw, id);
  let thread = base.thread;
  for (let sequence = base.sequence + 1; ; sequence += 1) {
    const segment = documents.get(threadSegmentDocument(id, sequence));
    if (segment === undefined) {
      return thread;
    }
    thread = applyLocalThreadDelta(thread, parseLocalThreadSegment(segment, id, sequence));
  }
}

/** One scripted model reply. Tool calls are emitted the way llama.rn reports them. */
export interface ScriptedReply {
  content?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** Rejects the completion, as a native generation failure does. */
  fail?: string;
}

interface HeldStep {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Deterministic stand-in for llama.rn contexts that keeps the real runtime's ordering: loads report
 * progress and may be held, completions stream tokens and may be held, `stopCompletion` interrupts
 * a held completion, and each live context occupies the memory its catalog entry estimates.
 */
export class FakeLlama {
  /** Every load request, in order. */
  readonly loads: { modelId: string; contextTokens: number }[] = [];
  /** Token counts of every prompt passed to completion, in order. */
  readonly promptTokens: number[] = [];
  /** `n_predict` of every completion, in order. */
  readonly predictBudgets: number[] = [];
  /** Live (unreleased) contexts with the memory each holds. */
  readonly resident = new Map<object, { modelId: string; bytes: number }>();
  /** Characters per token used by the fake tokenizer. */
  charactersPerToken = 4;
  holdLoads = false;
  holdCompletions = false;
  /** Keeps `stopCompletion` pending until `finishStop`, so the stopping phase is observable. */
  holdStops = false;
  /** Completions interrupted by `stopCompletion`. */
  stops = 0;
  private stopStep: (() => void) | null = null;
  private replies: ScriptedReply[] = [];
  private loadStep: (HeldStep & { progress: (value: number) => void }) | null = null;
  private completionStep: (HeldStep & { stream: (text: string) => void }) | null = null;
  releases = 0;

  /** Queues replies; once empty, every completion answers "Done.". */
  reply(...replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  get loadPending(): boolean {
    return this.loadStep !== null;
  }

  get completionPending(): boolean {
    return this.completionStep !== null;
  }

  residentBytes(): number {
    return [...this.resident.values()].reduce((total, entry) => total + entry.bytes, 0);
  }

  loadProgress(percent: number): void {
    this.loadStep?.progress(percent);
  }

  finishLoad(): void {
    const step = this.loadStep;
    this.loadStep = null;
    step?.resolve();
  }

  failLoad(message: string): void {
    const step = this.loadStep;
    this.loadStep = null;
    step?.reject(new Error(message));
  }

  /** Streams accumulated text into a held completion. */
  stream(text: string): void {
    this.completionStep?.stream(text);
  }

  finishCompletion(): void {
    const step = this.completionStep;
    this.completionStep = null;
    step?.resolve();
  }

  finishStop(): void {
    const step = this.stopStep;
    this.stopStep = null;
    step?.();
  }

  readonly loader: LocalContextLoader = async (model, _file, options, progress) => {
    this.loads.push({ modelId: model.id, contextTokens: options.contextTokens });
    progress(0);
    if (this.holdLoads) {
      await new Promise<void>((resolve, reject) => {
        this.loadStep = { resolve, reject, progress };
      });
    }
    progress(100);
    const context = this.context();
    this.resident.set(context, {
      modelId: model.id,
      bytes: residentModelBytes({ model, contextTokens: options.contextTokens }),
    });
    return context;
  };

  private context(): LocalModelContext {
    let interrupted = false;
    const context: LocalModelContext = {
      getFormattedChat: async (messages): Promise<FormattedChatResult> => ({
        type: 'jinja',
        prompt: JSON.stringify(messages),
        has_media: false,
      }),
      tokenize: async (text: string) => ({
        tokens: new Array<number>(Math.ceil(text.length / this.charactersPerToken)).fill(1),
      }),
      completion: async (params: CompletionParams, callback?: (value: TokenData) => void) => {
        interrupted = false;
        this.promptTokens.push(Math.ceil((params.prompt ?? '').length / this.charactersPerToken));
        this.predictBudgets.push(params.n_predict ?? -1);
        const script = this.replies.shift() ?? { content: 'Done.' };
        const emit = (text: string) =>
          callback?.({ token: text, content: text, accumulated_text: text });
        if (this.holdCompletions) {
          await new Promise<void>((resolve, reject) => {
            this.completionStep = { resolve, reject, stream: emit };
          });
        }
        if (script.fail) {
          throw new Error(script.fail);
        }
        if (!interrupted && script.content) {
          emit(script.content);
        }
        return reply(script, interrupted);
      },
      stopCompletion: async () => {
        this.stops += 1;
        if (this.holdStops) {
          await new Promise<void>((resolve) => {
            this.stopStep = resolve;
          });
        }
        interrupted = true;
        this.finishCompletion();
      },
      release: async () => {
        this.releases += 1;
        this.resident.delete(context);
      },
      isJinjaSupported: () => true,
    };
    return context;
  }
}

function reply(script: ScriptedReply, interrupted: boolean): LocalModelReply {
  return {
    content: interrupted ? '' : (script.content ?? ''),
    reasoning_content: '',
    tool_calls: interrupted
      ? []
      : (script.toolCalls ?? []).map((call, index) => ({
          type: 'function' as const,
          id: `call-${String(index)}`,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
    interrupted,
    truncated: false,
    stopped_limit: 0,
    tokens_predicted: 1,
    tokens_evaluated: 1,
  };
}

/** A reachability observer the test can flip. */
export class FakeNetwork implements OnDeviceNetworkPort {
  private listeners = new Set<(value: OnDeviceReachability) => void>();
  constructor(private value: OnDeviceReachability = 'online') {}
  current = async () => this.value;
  subscribe = (listener: (value: OnDeviceReachability) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(value: OnDeviceReachability): void {
    this.value = value;
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

export interface FakeNativeOptions {
  /** Catalog models whose verified weights are already installed. */
  downloaded?: string[];
  /** Free app memory before any model is loaded. */
  availableBytes?: number;
  physicalBytes?: number;
  workspaces?: LocalWorkspace[];
  /** Workspace files keyed by `${workspaceId}:${relativePath}`. */
  files?: Record<string, string>;
  /** Runtime documents (conversations, drafts, preferences) present at startup. */
  documents?: Record<string, string>;
}

function idleTransfer(id: string): NativeModelTransfer {
  return {
    id,
    state: 'idle',
    bytesWritten: 0,
    totalBytes: 0,
    resumable: false,
    interrupted: false,
    error: null,
  };
}

function gitStatus(): LocalGitStatus {
  return {
    branch: 'main',
    clean: true,
    raw: '',
    files: [],
    truncated: false,
    totalFiles: 0,
    omittedFiles: 0,
    maxFiles: 500,
    maxBytes: 1_000_000,
    stagedFiles: 0,
    hasOrigin: true,
    origin: 'https://github.com/acme/demo.git',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    detached: false,
    unborn: false,
  };
}

/**
 * In-memory native services with the same contracts as the Expo module: runtime documents,
 * workspaces and files (`''` is the root), background model transfers, verification, Git, and
 * memory that shrinks while `llama` holds a model. Every call is recorded in `calls`.
 */
export function createFakeOnDeviceNative(llama: FakeLlama, options: FakeNativeOptions = {}) {
  const documents = new Map(Object.entries(options.documents ?? {}));
  const files = new Map(Object.entries(options.files ?? {}));
  const transfers = new Map<string, NativeModelTransfer>();
  const staged = new Set<string>();
  const installed = new Set(options.downloaded ?? []);
  const calls: string[] = [];
  let writeFailure: string | null = null;
  const memory = {
    physicalBytes: options.physicalBytes ?? 8 * 1024 * MiB,
    availableBytes: options.availableBytes ?? 6 * 1024 * MiB,
  };
  let workspaces = options.workspaces ?? [{ id: 'ws-one', name: 'Demo', isRepository: true }];
  const record = (name: string, ...args: unknown[]) => {
    calls.push(args.length ? `${name}:${JSON.stringify(args)}` : name);
  };
  const modelFile = (id: string): LocalModelFile => {
    const model = localModelDefinition(id);
    return { id, uri: `file:///models/${id}.gguf`, bytes: model.bytes, sha256: model.sha256 };
  };
  const gitProgressListeners = new Set<(progress: NativeGitTransferProgress) => void>();
  const native: OnDeviceNativeServices = {
    getAPIVersion: () => ON_DEVICE_NATIVE_API_VERSION,
    getMemoryInfo: () => ({
      physicalBytes: memory.physicalBytes,
      availableBytes: memory.availableBytes - llama.residentBytes(),
      isSimulator: false,
    }),
    cancelGitTransfer: () => record('cancelGitTransfer'),
    getGitTransferProgress: () => ({ active: false, cancelled: false, completed: 0, total: 0 }),
    addListener: (_eventName, listener) => {
      gitProgressListeners.add(listener);
      return { remove: () => gitProgressListeners.delete(listener) };
    },
    storeGitCredential: async () => 'credential-ref',
    removeGitCredential: async () => undefined,
    listWorkspaces: async () => workspaces,
    createWorkspace: async (name) => {
      const workspace = { id: `ws-${String(workspaces.length + 1)}`, name, isRepository: false };
      workspaces = [...workspaces, workspace];
      return workspace;
    },
    cloneWorkspace: async (name) => ({ id: 'cloned', name, isRepository: true }),
    renameWorkspace: async (id, name) => ({ id, name, isRepository: true }),
    deleteWorkspace: async (id) => {
      workspaces = workspaces.filter((entry) => entry.id !== id);
    },
    getWorkspaceChangeToken: async (id) => `token-${id}-${String(files.size)}`,
    listWorkspaceFiles: async (id, path, limit) => {
      record('listWorkspaceFiles', id, path);
      const prefix = path ? `${id}:${path}/` : `${id}:`;
      const entries = new Map<string, { kind: 'file' | 'directory'; bytes: number }>();
      for (const [key, content] of files) {
        const [name, ...rest] = key.startsWith(prefix) ? key.slice(prefix.length).split('/') : [];
        if (name) {
          entries.set(
            name,
            rest.length ? { kind: 'directory', bytes: 0 } : { kind: 'file', bytes: content.length },
          );
        }
      }
      const list = [...entries].map(([name, value]) => ({ name, ...value }));
      return { entries: list.slice(0, limit), truncated: list.length > limit };
    },
    readWorkspaceFile: async (id, path, offset, limit) => {
      record('readWorkspaceFile', id, path);
      const content = files.get(`${id}:${path}`);
      if (content === undefined) {
        throw new OnDeviceNativeError('PATH_NOT_FOUND', 'The path does not exist.');
      }
      const end = Math.min(content.length, offset + limit);
      return {
        path,
        content: content.slice(offset, end),
        revision: `rev-${String(content.length)}`,
        nextOffset: end < content.length ? end : null,
        totalBytes: content.length,
      };
    },
    writeWorkspaceFile: async (id, path, content) => {
      record('writeWorkspaceFile', id, path);
      files.set(`${id}:${path}`, content);
      return `rev-${String(content.length)}`;
    },
    editWorkspaceFile: async () => 'rev-edited',
    renameWorkspacePath: async () => undefined,
    removeWorkspacePath: async () => undefined,
    renameWorkspaceEntry: async () => undefined,
    removeWorkspaceEntry: async () => undefined,
    searchWorkspaceFiles: async () => ({
      matches: [],
      truncated: false,
      skippedFiles: 0,
      visitedEntries: 0,
      searchedBytes: 0,
    }),
    getModelFilePaths: async (id) => ({
      partialUri: `file:///models/${id}/partial.gguf`,
      resumeUri: `file:///models/${id}/resume.json`,
      verificationBytes: staged.has(id) ? localModelDefinition(id).bytes : null,
      availableBytes: 64 * 1024 * 1024 * MiB,
    }),
    getDownloadedModelFile: async (id) => (installed.has(id) ? modelFile(id) : null),
    finalizeModelDownload: async (id) => {
      record('finalizeModelDownload', id);
      staged.delete(id);
      transfers.delete(id);
      installed.add(id);
      return modelFile(id);
    },
    removeModelFile: async (id) => {
      record('removeModelFile', id);
      transfers.delete(id);
      staged.delete(id);
      installed.delete(id);
    },
    attachModelDownloads: async () =>
      [...transfers.values()].filter((transfer) => transfer.state === 'running'),
    startModelDownload: async (id, _url, totalBytes) => {
      record('startModelDownload', id);
      const paused = transfers.get(id);
      const transfer: NativeModelTransfer = {
        ...idleTransfer(id),
        state: 'running',
        totalBytes,
        bytesWritten: paused?.state === 'paused' ? paused.bytesWritten : 0,
      };
      transfers.set(id, transfer);
      return transfer;
    },
    pauseModelDownload: async (id) => {
      record('pauseModelDownload', id);
      const current = transfers.get(id);
      if (current?.state === 'running') {
        transfers.set(id, { ...current, state: 'paused', resumable: true });
      }
      return transfers.get(id) ?? idleTransfer(id);
    },
    cancelModelDownload: async (id) => {
      record('cancelModelDownload', id);
      transfers.delete(id);
    },
    getModelDownload: (id) => {
      if (staged.has(id)) {
        const bytes = localModelDefinition(id).bytes;
        return { ...idleTransfer(id), state: 'completed', bytesWritten: bytes, totalBytes: bytes };
      }
      return transfers.get(id) ?? idleTransfer(id);
    },
    getModelVerificationProgress: () => ({ active: false, completed: 0, total: 0 }),
    cancelModelVerification: () => undefined,
    getModelStorageInfo: async () => ({
      usedBytes: [...installed].reduce((total, id) => total + localModelDefinition(id).bytes, 0),
      freeBytes: 64 * 1024 * MiB,
      capacityBytes: 128 * 1024 * MiB,
      models: [...installed].map((id) => ({ id, bytes: localModelDefinition(id).bytes })),
    }),
    readRuntimeDocument: async (name) => documents.get(name) ?? null,
    writeRuntimeDocument: async (name, content) => {
      if (writeFailure) {
        throw new OnDeviceNativeError('STORAGE_FAILURE', writeFailure);
      }
      documents.set(name, content);
    },
    listRuntimeDocuments: async (prefix) =>
      [...documents.keys()].filter((key) => key.startsWith(prefix)),
    removeRuntimeDocument: async (name) => {
      documents.delete(name);
    },
    getWorkspaceGitStatus: async () => gitStatus(),
    getWorkspaceGitDiff: async () => ({
      diff: '',
      truncated: false,
      originalBytes: 0,
      returnedBytes: 0,
      maxBytes: 1_000_000,
    }),
    getWorkspaceGitHistory: async () => ({ commits: [] }),
    getWorkspaceGitBranches: async () => ({
      branches: [{ name: 'main', remote: false, current: true }],
    }),
    stageWorkspaceGit: async () => undefined,
    unstageWorkspaceGit: async () => undefined,
    commitWorkspaceGit: async () => 'commit-hash',
    switchWorkspaceGitBranch: async () => undefined,
    createWorkspaceGitBranch: async () => undefined,
    discardWorkspaceGit: async () => undefined,
    initWorkspaceGit: async (id) => ({ id, name: id, isRepository: true }),
    getWorkspaceGitOrigin: async () => 'https://github.com/acme/demo.git',
    fetchWorkspaceGit: async () => undefined,
    pullWorkspaceGit: async () => ({ outcome: 'up-to-date', from: 'a', to: 'a' }),
    pushWorkspaceGit: async (id) => record('pushWorkspaceGit', id),
  };
  return {
    native,
    calls,
    documents,
    files,
    transfers,
    installed,
    memory,
    gitProgressListeners,
    /** Sends a Git transfer progress event, as the native module does while objects arrive. */
    emitGitTransferProgress(progress: NativeGitTransferProgress): void {
      for (const listener of [...gitProgressListeners]) {
        listener(progress);
      }
    },
    /** Moves a running background transfer forward, as URLSession progress does. */
    progressDownload(id: string, bytesWritten: number): void {
      const current = transfers.get(id);
      if (current) {
        transfers.set(id, { ...current, bytesWritten });
      }
    },
    /** Makes runtime document writes fail with `message` until called with null. */
    failRuntimeWrites(message: string | null): void {
      writeFailure = message;
    },
    /** Finishes a background transfer: the file is staged for verification. */
    completeDownload(id: string): void {
      transfers.delete(id);
      staged.add(id);
    },
  };
}

export type FakeOnDeviceNative = ReturnType<typeof createFakeOnDeviceNative>;
