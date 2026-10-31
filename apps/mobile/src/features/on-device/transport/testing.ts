/* eslint-disable @typescript-eslint/require-await -- the fake mirrors the async port contract */
import type { LocalModelDefinition } from '../models/types';
import { localModelDefinition } from '../models/catalog';
import type { LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalMessage, LocalThread } from '../runtime/types';
import type { LocalWorkspace } from '../workspaces/types';
import type { LocalAgentPort, LocalGitPort } from './port';

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
  };

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
        title: thread.messages.length === 0 ? text.slice(0, 60) : thread.title,
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

  settle(threadId: string, status: LocalThread['status'], error: string | null = null): void {
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
}
