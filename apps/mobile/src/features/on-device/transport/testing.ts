/* eslint-disable @typescript-eslint/require-await -- the fake mirrors the async port contract */
import type { LocalModelDefinition } from '../models/types';
import { localModelDefinition } from '../models/catalog';
import { localConversationTitle, type LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalMessage, LocalThread } from '../runtime/types';
import { OnDeviceNativeError } from '../native/services.errors';
import type { LocalWorkspace } from '../workspaces/types';
import type { LocalAgentPort, LocalFilesPort, LocalGitPort, LocalWorkspaceAdminPort } from './port';

/** A typed native failure, as the native module reports it, for tests outside `on-device`. */
export function fakeNativeError(
  code: ConstructorParameters<typeof OnDeviceNativeError>[0],
  message: string,
): Error {
  return new OnDeviceNativeError(code, message);
}

const IDLE: LocalRunSnapshot = {
  phase: 'idle',
  threadId: null,
  turnId: null,
  toolName: null,
  approval: null,
};

/**
 * Scripted, in-memory `LocalAgentPort` for transport and shell tests. Tests drive a run step by
 * step (`streamAssistant`, `startTool`, `finishTool`, `settle`) exactly the way the agent loop
 * mutates thread state, so the transport's event projection is exercised without native code.
 */
export class FakeAgentPort implements LocalAgentPort {
  readonly listeners = new Set<() => void>();
  readonly cloneProgressListeners = new Set<
    Parameters<LocalAgentPort['workspaceAdmin']['onCloneProgress']>[0]
  >();
  readonly threadMap = new Map<string, LocalThread>();
  workspaceList: LocalWorkspace[] = [{ id: 'ws-one', name: 'Demo', isRepository: true }];
  models: LocalModelDefinition[] = [localModelDefinition('qwen3-1.7b-q4-k-m')];
  defaultValues: { workspaceId: string | null; modelId: string | null } = {
    workspaceId: null,
    modelId: null,
  };
  runValue: LocalRunSnapshot = IDLE;
  modelValue: ReturnType<LocalAgentPort['modelSession']> = {
    phase: 'empty',
    modelId: null,
    progress: 0,
    error: null,
  };
  sendError: Error | null = null;
  private counter = 0;
  private pending: {
    resolve: (thread: LocalThread) => void;
    reject: (error: Error) => void;
  } | null = null;
  readonly calls: string[] = [];
  readonly git: LocalGitPort = {
    status: async () => ({
      branch: 'main',
      clean: false,
      raw: ' M README.md',
      files: [
        {
          path: 'README.md',
          indexStatus: ' ',
          worktreeStatus: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
        },
      ],
      truncated: false,
      totalFiles: 1,
      omittedFiles: 0,
      maxFiles: 500,
      maxBytes: 1_000_000,
      stagedFiles: 0,
      hasOrigin: false,
      origin: null,
      upstream: null,
      ahead: null,
      behind: null,
      detached: false,
      unborn: false,
    }),
    diff: async () => ({
      diff: 'diff --git a/README.md b/README.md\n+hello\n',
      truncated: false,
      originalBytes: 40,
      returnedBytes: 40,
      maxBytes: 1_000_000,
    }),
    history: async () => ({
      commits: [1, 2, 3].map((index) => ({
        hash: `hash-${String(index)}`,
        shortHash: `h${String(index)}`,
        subject: `Commit ${String(index)}`,
        authorName: 'Ada',
        authoredAt: '2026-10-01T00:00:00.000Z',
        refNames: [],
        isHead: index === 1,
      })),
    }),
    branches: async () => ({
      branches: [{ name: 'main', remote: false, current: true }],
    }),
    stage: async (...args: unknown[]) => {
      this.calls.push(`git.stage:${JSON.stringify(args)}`);
    },
    unstage: async (...args: unknown[]) => {
      this.calls.push(`git.unstage:${JSON.stringify(args)}`);
    },
    commit: async (...args: unknown[]) => {
      this.calls.push(`git.commit:${JSON.stringify(args)}`);
    },
    switchBranch: async (...args: unknown[]) => {
      this.calls.push(`git.switchBranch:${JSON.stringify(args)}`);
    },
    push: async (...args: unknown[]) => {
      this.calls.push(`git.push:${JSON.stringify(args)}`);
    },
    fetch: async (...args: unknown[]) => {
      this.calls.push(`git.fetch:${JSON.stringify(args)}`);
    },
    pull: async (...args: unknown[]) => {
      this.calls.push(`git.pull:${JSON.stringify(args)}`);
      return { outcome: 'fast-forwarded', from: 'aaaaaaa', to: 'bbbbbbbbbb' };
    },
    init: async (id: string, ...args: unknown[]) => {
      this.calls.push(`git.init:${JSON.stringify([id, ...args])}`);
      const workspace = this.workspaceList.find((entry) => entry.id === id);
      return { id, name: workspace?.name ?? id, isRepository: true };
    },
    discard: async (...args: unknown[]) => {
      this.calls.push(`git.discard:${JSON.stringify(args)}`);
    },
    createBranch: async (...args: unknown[]) => {
      this.calls.push(`git.createBranch:${JSON.stringify(args)}`);
    },
  };
  networkValue: 'online' | 'offline' | 'unknown' = 'online';
  /** Workspace files keyed by `${workspaceId}:${path}`; directories are implied by their files. */
  readonly fileMap = new Map<string, string>();
  readonly workspaceAdmin: LocalWorkspaceAdminPort = {
    create: async (name) => {
      this.calls.push(`workspace.create:${name}`);
      const workspace = { id: `ws-${String(++this.counter)}`, name, isRepository: false };
      this.workspaceList = [...this.workspaceList, workspace];
      return workspace;
    },
    select: async (id) => {
      this.calls.push(`workspace.select:${id}`);
      this.defaultValues = { ...this.defaultValues, workspaceId: id };
    },
    rename: async (id, name) => {
      this.calls.push(`workspace.rename:${id}:${name}`);
      this.workspaceList = this.workspaceList.map((entry) =>
        entry.id === id ? { ...entry, name } : entry,
      );
      return (
        this.workspaceList.find((entry) => entry.id === id) ?? { id, name, isRepository: false }
      );
    },
    delete: async (id) => {
      this.calls.push(`workspace.delete:${id}`);
      this.workspaceList = this.workspaceList.filter((entry) => entry.id !== id);
    },
    clone: async (name, url) => {
      this.calls.push(`workspace.clone:${name}:${url}`);
      const workspace = { id: `ws-${String(++this.counter)}`, name, isRepository: true };
      this.workspaceList = [...this.workspaceList, workspace];
      return workspace;
    },
    cloneProgress: () => ({ active: false, cancelled: false, completed: 0, total: 0 }),
    onCloneProgress: (listener) => {
      this.cloneProgressListeners.add(listener);
      return () => {
        this.cloneProgressListeners.delete(listener);
      };
    },
    cancelTransfer: () => {
      this.calls.push('workspace.cancelTransfer');
    },
    changeToken: async (id) => `token-${id}-${String(this.fileMap.size)}`,
    metadata: async () => ({ branch: 'main', origin: 'https://github.com/acme/demo.git' }),
  };
  readonly files: LocalFilesPort = {
    list: async (id, path, limit) => {
      const prefix = path ? `${id}:${path}/` : `${id}:`;
      const names = new Map<string, { kind: 'file' | 'directory'; bytes: number }>();
      for (const [key, content] of this.fileMap) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const [name, ...rest] = key.slice(prefix.length).split('/');
        if (name) {
          names.set(
            name,
            rest.length
              ? { kind: 'directory', bytes: 0 }
              : {
                  kind: 'file',
                  bytes: content.length,
                },
          );
        }
      }
      const entries = [...names].map(([name, value]) => ({ name, ...value }));
      return { entries: entries.slice(0, limit), truncated: entries.length > limit };
    },
    read: async (id, path, offset, limit) => {
      const content = this.fileMap.get(`${id}:${path}`);
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
    write: async (id, path, content, revision) => {
      this.calls.push(`files.write:${JSON.stringify([id, path, revision])}`);
      const existing = this.fileMap.get(`${id}:${path}`);
      if ((existing === undefined) !== (revision === null)) {
        throw new OnDeviceNativeError('FILE_REVISION_CONFLICT', 'The file changed.');
      }
      this.fileMap.set(`${id}:${path}`, content);
      return `rev-${String(content.length)}`;
    },
    rename: async (id, path, destination) => {
      this.calls.push(`files.rename:${JSON.stringify([id, path, destination])}`);
      const content = this.fileMap.get(`${id}:${path}`) ?? '';
      this.fileMap.delete(`${id}:${path}`);
      this.fileMap.set(`${id}:${destination}`, content);
    },
    remove: async (id, path) => {
      this.calls.push(`files.remove:${JSON.stringify([id, path])}`);
      this.fileMap.delete(`${id}:${path}`);
    },
  };
  network = () => this.networkValue;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  threads = () =>
    [...this.threadMap.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  thread = (id: string) => this.threadMap.get(id) ?? null;
  run = () => this.runValue;
  workspaces = () => this.workspaceList;
  refreshWorkspaces = async () => {
    this.calls.push('refreshWorkspaces');
  };
  defaults = () => this.defaultValues;
  availableModels = () => this.models;
  loadedModelId: string | null = null;
  modelChoices = () =>
    this.models.map((model) => ({
      model,
      residency: model.id === this.loadedModelId ? ('loaded' as const) : ('idle' as const),
      loadProgress: 0,
      contextTokens: model.id === this.loadedModelId ? model.maxContextTokens : null,
    }));
  chooseModel = async (threadId: string, modelId: string) => {
    this.calls.push(`chooseModel:${threadId}:${modelId}`);
    this.defaultValues = { ...this.defaultValues, modelId };
    return this.change(threadId, (thread) => ({ ...thread, modelId }));
  };

  createThread = async (workspaceId: string, modelId: string) => {
    this.calls.push(`create:${workspaceId}:${modelId}`);
    const now = this.now();
    const thread: LocalThread = {
      version: 1,
      id: `thread-${String(++this.counter)}`,
      title: 'New local conversation',
      workspaceId,
      modelId,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      activeTurnId: null,
      lastSubmissionId: null,
      lastError: null,
      messages: [],
    };
    this.put(thread);
    return thread;
  };

  updateThread = async (id: string, patch: Partial<LocalThread>) => {
    this.calls.push(`update:${id}:${JSON.stringify(patch)}`);
    return this.change(id, (thread) => ({ ...thread, ...patch }));
  };

  deleteThread = async (id: string) => {
    this.calls.push(`delete:${id}`);
    if (this.threadMap.get(id)?.status === 'running') {
      throw new Error('Stop the local run before deleting its conversation.');
    }
    this.threadMap.delete(id);
    this.emit();
  };

  /**
   * Like the real loop, a run first loads its model (`preparing`, thread not yet running) and only
   * then records the user message. With `holdModelLoad`, the load waits for `finishModelLoad` or
   * `failModelLoad`; otherwise it completes immediately after the `preparing` notification.
   */
  holdModelLoad = false;
  private loading: { threadId: string; begin: () => void } | null = null;

  send = (id: string, text: string, submissionId: string, accepted: () => void) => {
    this.calls.push(`send:${id}:${text}`);
    if (this.sendError) {
      return Promise.reject(this.sendError);
    }
    const turnId = `turn-${String(++this.counter)}`;
    return this.startRun(id, turnId, () => {
      this.change(id, (thread) => ({
        ...thread,
        status: 'running',
        activeTurnId: turnId,
        lastSubmissionId: submissionId,
        lastError: null,
        title: thread.messages.length === 0 ? localConversationTitle(text) : thread.title,
        messages: [
          ...thread.messages,
          { id: `user-${submissionId}`, role: 'user', content: text, createdAt: this.now() },
        ],
      }));
      accepted();
    });
  };

  stop = async () => {
    this.calls.push('stop');
    const threadId = this.runValue.threadId;
    if (!threadId) {
      return;
    }
    this.runValue = { ...this.runValue, phase: 'stopping' };
    this.emit();
    if (this.loading) {
      // A stopped load abandons the run without recording anything, as the real loop does.
      this.loading = null;
      const thread = this.threadMap.get(threadId);
      this.endRun((pending) => {
        if (thread) {
          pending?.resolve(thread);
        }
      });
      return;
    }
    this.settle(threadId, 'interrupted', 'Stopped. Completed edits are preserved.');
  };

  modelSession = () => this.modelValue;

  /** Changes the resident model state, as loading progress and failures do. */
  setModel(update: Partial<ReturnType<LocalAgentPort['modelSession']>>): void {
    this.modelValue = { ...this.modelValue, ...update };
    this.emit();
  }

  /** Completes a held model load: the run records its turn and the thread starts running. */
  finishModelLoad(): void {
    const loading = this.loading;
    this.loading = null;
    loading?.begin();
  }

  /** Fails a held model load, leaving history untouched apart from `lastError`. */
  failModelLoad(message: string): void {
    const loading = this.loading;
    if (!loading) {
      return;
    }
    this.loading = null;
    this.change(loading.threadId, (thread) => ({ ...thread, lastError: message }));
    this.endRun((pending) => pending?.reject(new Error(message)));
  }

  retryTurn = (id: string) => {
    this.calls.push(`retry:${id}`);
    const thread = this.threadMap.get(id);
    if (!thread || (thread.status !== 'failed' && thread.status !== 'interrupted')) {
      return Promise.reject(new Error('This conversation has no failed or stopped turn to retry.'));
    }
    const turnId = `turn-${String(++this.counter)}`;
    return this.startRun(id, turnId, () => {
      this.change(id, (current) => ({
        ...current,
        status: 'running',
        activeTurnId: turnId,
        lastError: null,
      }));
    });
  };

  private startRun(id: string, turnId: string, begin: () => void): Promise<LocalThread> {
    this.runValue = { phase: 'preparing', threadId: id, turnId, toolName: null, approval: null };
    const promise = new Promise<LocalThread>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    this.emit();
    if (this.holdModelLoad) {
      this.loading = { threadId: id, begin };
    } else {
      begin();
    }
    return promise;
  }

  private endRun(
    settle: (
      pending: { resolve: (t: LocalThread) => void; reject: (e: Error) => void } | null,
    ) => void,
  ): void {
    this.runValue = IDLE;
    this.emit();
    const pending = this.pending;
    this.pending = null;
    settle(pending);
  }

  readonly approvals: { callId: string; approved: boolean }[] = [];

  resolveApproval = (callId: string, approved: boolean) => {
    if (this.runValue.approval?.callId !== callId) {
      throw new Error('This approval request is no longer pending.');
    }
    this.approvals.push({ callId, approved });
    this.runValue = { ...this.runValue, phase: 'tool', approval: null };
    this.emit();
  };

  /** Asks for approval of a tool call, as the loop does for network side effects. */
  requestApproval(threadId: string, callId: string, toolName: string, summary: string): void {
    this.runValue = {
      ...this.runValue,
      phase: 'approval',
      toolName,
      approval: { threadId, turnId: this.runValue.turnId ?? '', callId, toolName, summary },
    };
    this.emit();
  }

  /** Appends or grows an assistant message, as streamed tokens do. */
  streamAssistant(threadId: string, messageId: string, content: string, reasoning = ''): void {
    this.runValue = { ...this.runValue, phase: 'generating' };
    this.change(threadId, (thread) => {
      const exists = thread.messages.some((message) => message.id === messageId);
      const message: LocalMessage = {
        id: messageId,
        role: 'assistant',
        content,
        reasoning,
        createdAt: this.now(),
      };
      return {
        ...thread,
        messages: exists
          ? thread.messages.map((entry) =>
              entry.id === messageId ? { ...entry, content, reasoning } : entry,
            )
          : [...thread.messages, message],
      };
    });
  }

  startTool(threadId: string, assistantId: string, callId: string, name: string, args: string) {
    this.runValue = { ...this.runValue, phase: 'tool', toolName: name };
    this.change(threadId, (thread) => ({
      ...thread,
      messages: [
        ...thread.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                toolCalls: [
                  { id: callId, type: 'function' as const, function: { name, arguments: args } },
                ],
              }
            : message,
        ),
        {
          id: `tool-${callId}`,
          role: 'tool',
          content: '',
          createdAt: this.now(),
          tool: { callId, name, status: 'running', startedAt: this.now() },
        },
      ],
    }));
  }

  finishTool(threadId: string, callId: string, content: string, status: 'completed' | 'failed') {
    this.change(threadId, (thread) => ({
      ...thread,
      messages: thread.messages.map((message) =>
        message.tool?.callId === callId
          ? {
              ...message,
              content,
              tool: { ...message.tool, status, completedAt: this.now() },
            }
          : message,
      ),
    }));
  }

  /** Settles the run the way the loop does: it saves (`persisting`), then the thread settles. */
  settle(threadId: string, status: LocalThread['status'], error: string | null = null): void {
    this.runValue = { ...this.runValue, phase: 'persisting', toolName: null, approval: null };
    this.emit();
    const thread = this.change(threadId, (current) => ({
      ...current,
      status,
      activeTurnId: null,
      lastError: error,
    }));
    this.runValue = IDLE;
    this.emit();
    const pending = this.pending;
    this.pending = null;
    if (status === 'failed') {
      pending?.reject(new Error(error ?? 'failed'));
    } else {
      pending?.resolve(thread);
    }
  }

  put(thread: LocalThread): void {
    this.threadMap.set(thread.id, thread);
    this.emit();
  }

  private change(id: string, update: (thread: LocalThread) => LocalThread): LocalThread {
    const current = this.threadMap.get(id);
    if (!current) {
      throw new Error('This local conversation is unavailable.');
    }
    const next = { ...update(current), updatedAt: this.now() };
    this.threadMap.set(id, next);
    this.emit();
    return next;
  }

  private now(): string {
    return new Date(Date.UTC(2026, 9, 1, 0, 0, this.counter++)).toISOString();
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** Delivers a native transfer progress event, as the Expo module would. */
  emitCloneProgress(progress: ReturnType<LocalAgentPort['workspaceAdmin']['cloneProgress']>): void {
    for (const listener of [...this.cloneProgressListeners]) {
      listener(progress);
    }
  }
}
