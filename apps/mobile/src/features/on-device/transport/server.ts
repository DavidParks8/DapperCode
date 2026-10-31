import type {
  BridgeThreadQueueState,
  FileSystemListResponse,
  WorkspaceListResponse,
} from '@bridge/types/types';
import type { LocalThread } from '../runtime/types';
import { failure, LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import { forwardLocalCloneProgress, LocalEventProjector, type LocalNotification } from './events';
import { LocalApprovalRelay } from './approvals';
import { createLocalGitHandlers } from './gitHandlers';
import { localModelListEntries } from './modelOptions';
import { LOCAL_TURN_RETRY_METHOD, startLocalRetry } from './retry';
import { createLocalWorkspaceHandlers, LOCAL_WORKSPACE_METHODS } from './workspaceHandlers';
import { readParam, readRecord, type RpcParams } from './params';
import type { LocalAgentPort } from './port';
import {
  LOCAL_MODEL_CONFIG_ID,
  LOCAL_WORKSPACE_ROOT,
  localCapabilities,
  localRunActivity,
  localWorkspaceIdForPath,
  localWorkspacePaths,
  localThreadSnapshot,
  localThreadSummary,
  type LocalThreadProjectionContext,
} from './wire';

export type { LocalNotification } from './events';
export { LOCAL_RPC_ERROR, LocalRpcError, type LocalRpcErrorReason } from './errors';

/** The JSON-RPC endpoint the shell's local WebSocket adapter talks to. */
export interface LocalRpcEndpoint {
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (notification: LocalNotification) => void): () => void;
  start(): void;
  stop(): void;
}

type Params = RpcParams;

export { LOCAL_TURN_RETRY_METHOD } from './retry';

type Handler = (params: Params) => unknown;

/**
 * Methods the local agent answers. Everything else is rejected with `methodNotFound` and
 * `data.error === 'unsupported_on_device'`; the shell additionally hides those affordances
 * through `localCapabilities()` and the local profile's feature flags.
 */
export const LOCAL_IMPLEMENTED_METHODS = [
  'bridge/capabilities/read',
  'bridge/health/read',
  'thread/approvalPolicy/set',
  'thread/list',
  'thread/loaded/list',
  'bridge/thread/list/stream/start',
  'bridge/thread/list/stream/cancel',
  'thread/read',
  'thread/start',
  'bridge/thread/create',
  'thread/name/update',
  'thread/delete',
  'thread/config/set',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
  LOCAL_TURN_RETRY_METHOD,
  'bridge/thread/queue/send',
  'bridge/thread/queue/read',
  'bridge/thread/schedules/read',
  'model/list',
  'bridge/workspaces/list',
  'bridge/fs/list',
  'bridge/approvals/list',
  'bridge/approvals/resolve',
  'bridge/userInput/list',
  'bridge/git/status',
  'bridge/git/diff',
  'bridge/git/history',
  'bridge/git/branches',
  'bridge/git/stage',
  'bridge/git/stageAll',
  'bridge/git/unstage',
  'bridge/git/unstageAll',
  'bridge/git/commit',
  'bridge/git/switch',
  'bridge/git/push',
  ...LOCAL_WORKSPACE_METHODS,
] as const;

function emptyQueue(threadId: string): BridgeThreadQueueState {
  return {
    threadId,
    items: [],
    pendingSteers: [],
    pendingSteerCount: 0,
    waitingForToolCalls: false,
    steeringInFlight: false,
    lastError: null,
  };
}

function inputText(params: Params): string {
  const input = Array.isArray(params['input']) ? params['input'] : [];
  return input
    .map((entry) => readRecord(entry))
    .filter((entry) => entry['type'] === 'text' && typeof entry['text'] === 'string')
    .map((entry) => entry['text'] as string)
    .join('\n');
}

/**
 * In-process implementation of the subset of the bridge JSON-RPC protocol that the chat shell
 * uses, backed by the on-device agent. It returns the same wire shapes as the Rust bridge so the
 * unchanged `HostBridgeApiClient` and chat shell can drive a local agent.
 */
export class LocalBridgeServer implements LocalRpcEndpoint {
  private readonly listeners = new Set<(notification: LocalNotification) => void>();
  private readonly projector: LocalEventProjector;
  private readonly createdBySubmission = new Map<string, string>();
  private readonly handlers: Record<string, Handler>;
  private unsubscribe: (() => void) | null = null;
  private readonly approvals: LocalApprovalRelay;
  private flushing = false;
  private dirty = false;

  constructor(private readonly port: LocalAgentPort) {
    this.projector = new LocalEventProjector(
      () => this.context(),
      (thread) => localRunActivity(thread, this.port.run(), this.port.modelSession()),
      () => this.port.run(),
    );
    this.approvals = new LocalApprovalRelay(port);
    this.handlers = this.createHandlers();
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.projector.prime(this.port.threads());
    this.approvals.prime();
    const stopThreads = this.port.subscribe(() => this.flush());
    const stopProgress = forwardLocalCloneProgress(this.port, (event) => this.publish(event));
    this.unsubscribe = () => {
      stopThreads();
      stopProgress();
    };
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onNotification(listener: (notification: LocalNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const handler = this.handlers[method];
    if (!handler) {
      throw new LocalRpcError(
        LOCAL_RPC_ERROR.methodNotFound,
        `${method} is not available on this iPhone.`,
        { error: 'unsupported_on_device', method },
      );
    }
    try {
      return await handler(readRecord(params));
    } catch (error) {
      throw failure(error);
    }
  }

  private context(): LocalThreadProjectionContext {
    return { workspaces: this.port.workspaces(), models: this.port.availableModels() };
  }

  private flush(): void {
    if (this.flushing) {
      this.dirty = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.dirty = false;
        for (const notification of this.projector.diff(this.port.threads())) {
          this.publish(notification);
        }
        for (const notification of this.approvals.diff()) {
          this.publish(notification);
        }
      } while (this.dirty);
    } finally {
      this.flushing = false;
    }
  }

  private publish(notification: LocalNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch (error) {
        console.error('A local transport listener failed:', error);
      }
    }
  }

  private requireThread(params: Params): LocalThread {
    const threadId = readParam(params, 'threadId');
    const thread = threadId ? this.port.thread(threadId) : null;
    if (!thread || !threadId) {
      throw new LocalRpcError(LOCAL_RPC_ERROR.notFound, 'Thread not found', {
        error: 'thread_not_found',
        threadId: threadId ?? '',
      });
    }
    return thread;
  }

  private snapshot(thread: LocalThread) {
    return localThreadSnapshot(this.port.thread(thread.id) ?? thread, this.context());
  }

  private availableModel(modelId: string | null): string | null {
    return modelId && this.port.availableModels().some((model) => model.id === modelId)
      ? modelId
      : null;
  }

  /** The model a new chat uses when none is requested, or null when none is downloaded. */
  private defaultModel(): string | null {
    const recent = this.port.threads()[0]?.modelId ?? null;
    return (
      this.availableModel(this.port.defaults().modelId) ??
      this.availableModel(recent) ??
      this.port.availableModels()[0]?.id ??
      null
    );
  }

  private resolveModel(requested: string | null): string {
    const model = this.availableModel(requested) ?? this.defaultModel();
    if (!model) {
      throw new LocalRpcError(
        LOCAL_RPC_ERROR.serverError,
        'Download a model for On this iPhone before starting a chat.',
        { error: 'on_device_model_required' },
      );
    }
    return model;
  }

  /** Local workspace id for a presented path. Paths outside the local root are ignored. */
  private async workspaceForPath(path: string | null): Promise<string | null> {
    if (!path || !path.startsWith(LOCAL_WORKSPACE_ROOT)) {
      return null;
    }
    let id = localWorkspaceIdForPath(this.port.workspaces(), path);
    if (!id) {
      await this.port.refreshWorkspaces();
      id = localWorkspaceIdForPath(this.port.workspaces(), path);
    }
    if (!id) {
      throw new LocalRpcError(
        LOCAL_RPC_ERROR.invalidParams,
        'That workspace is no longer on this iPhone.',
        { error: 'on_device_workspace_required', path },
      );
    }
    return id;
  }

  private async resolveWorkspace(path: string | null): Promise<string> {
    const requested = await this.workspaceForPath(path);
    if (requested) {
      return requested;
    }
    const workspaces = this.port.workspaces();
    const exists = (id: string | null | undefined) =>
      id && workspaces.some((workspace) => workspace.id === id) ? id : null;
    const fallback =
      exists(this.port.defaults().workspaceId) ??
      exists(this.port.threads()[0]?.workspaceId) ??
      (workspaces.length === 1 ? (workspaces[0]?.id ?? null) : null);
    if (!fallback) {
      throw new LocalRpcError(
        LOCAL_RPC_ERROR.invalidParams,
        workspaces.length === 0
          ? 'Create or clone a workspace on this iPhone before starting a chat.'
          : 'Choose a workspace for this chat.',
        { error: 'on_device_workspace_required' },
      );
    }
    return fallback;
  }

  private async gitWorkspace(params: Params): Promise<{ id: string; cwd: string }> {
    const cwd = readParam(params, 'cwd');
    const id = await this.workspaceForPath(cwd);
    if (!id || !cwd) {
      throw new LocalRpcError(
        LOCAL_RPC_ERROR.invalidParams,
        'Choose a workspace on this iPhone first.',
        { error: 'on_device_workspace_required' },
      );
    }
    return { id, cwd };
  }

  private async createThread(threadStart: Params, submissionId: string | null) {
    const existing = submissionId ? this.createdBySubmission.get(submissionId) : undefined;
    const existingThread = existing ? this.port.thread(existing) : null;
    if (existingThread) {
      return existingThread;
    }
    const workspaceId = await this.resolveWorkspace(readParam(threadStart, 'cwd'));
    const modelId = this.resolveModel(readParam(threadStart, 'model'));
    const thread = await this.port.createThread(workspaceId, modelId);
    if (submissionId) {
      this.createdBySubmission.set(submissionId, thread.id);
    }
    return thread;
  }

  /** Applies a turn's requested model before running it, as the bridge does per turn. */
  private async applyTurnModel(thread: LocalThread, params: Params): Promise<void> {
    const model = this.availableModel(readParam(params, 'model'));
    if (model && model !== thread.modelId) {
      await this.port.updateThread(thread.id, { modelId: model });
    }
  }

  /** Resolves once the user message is part of the thread, then lets the run continue. */
  private startTurn(thread: LocalThread, content: string, submissionId: string): Promise<string> {
    if (!content.trim()) {
      return Promise.reject(
        new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'Enter a message.', {
          error: 'on_device_failed',
        }),
      );
    }
    const userMessageId = `user-${submissionId}`;
    if (thread.messages.some((message) => message.id === userMessageId)) {
      return Promise.resolve(
        thread.activeTurnId ?? `submission-${thread.lastSubmissionId ?? submissionId}`,
      );
    }
    const run = this.port.run();
    if (run.phase !== 'idle' && run.threadId !== thread.id) {
      return Promise.reject(
        new LocalRpcError(
          LOCAL_RPC_ERROR.serverError,
          'Another chat is running on this iPhone. Stop it or wait for it to finish.',
          { error: 'on_device_busy', threadId: run.threadId },
        ),
      );
    }
    return new Promise<string>((resolve, reject) => {
      let accepted = false;
      const accept = () => {
        if (accepted) {
          return;
        }
        accepted = true;
        const latest = this.port.thread(thread.id);
        resolve(latest?.activeTurnId ?? this.port.run().turnId ?? `submission-${submissionId}`);
      };
      this.port.send(thread.id, content, submissionId, accept).then(accept, (error: unknown) => {
        // After acceptance a failure reaches the shell as a RUN_ERROR event instead.
        if (!accepted) {
          reject(failure(error));
        }
      });
    });
  }

  private workspaceList(): WorkspaceListResponse {
    const threads = this.port.threads();
    return {
      bridgeRoot: LOCAL_WORKSPACE_ROOT,
      allowOutsideRootCwd: false,
      workspaces: [...localWorkspacePaths(this.port.workspaces())].map(([id, path]) => {
        const owned = threads.filter((thread) => thread.workspaceId === id);
        return {
          path,
          chatCount: owned.length,
          ...(owned[0] ? { updatedAt: owned[0].updatedAt } : {}),
        };
      }),
    };
  }

  private filesystemList(path: string | null): FileSystemListResponse {
    const atRoot = !path || path === LOCAL_WORKSPACE_ROOT;
    const workspaces = this.port.workspaces();
    const entries = atRoot
      ? [...localWorkspacePaths(workspaces)].map(([id, entryPath]) => ({
          name: entryPath.slice(LOCAL_WORKSPACE_ROOT.length + 1),
          path: entryPath,
          kind: 'directory',
          hidden: false,
          selectable: true,
          isGitRepo: workspaces.find((workspace) => workspace.id === id)?.isRepository === true,
        }))
      : [];
    return {
      bridgeRoot: LOCAL_WORKSPACE_ROOT,
      path: atRoot ? LOCAL_WORKSPACE_ROOT : path,
      parentPath: atRoot ? null : LOCAL_WORKSPACE_ROOT,
      entries,
      truncated: false,
      totalEntries: entries.length,
      omittedEntries: 0,
      maxEntries: entries.length,
    };
  }

  private createHandlers(): Record<string, Handler> {
    const port = this.port;
    const handlers: Record<(typeof LOCAL_IMPLEMENTED_METHODS)[number], Handler> = {
      'bridge/capabilities/read': () => localCapabilities(),
      'bridge/health/read': () => ({ ok: true, status: 'ok', backend: 'on-device' }),
      'thread/approvalPolicy/set': () => ({ ok: true }),
      'thread/list': (params) => {
        const all = port.threads();
        const offset = Number.parseInt(readParam(params, 'cursor') ?? '0', 10) || 0;
        const limit =
          typeof params['limit'] === 'number' && params['limit'] > 0
            ? Math.trunc(params['limit'])
            : all.length;
        const page = all.slice(offset, offset + limit);
        const next = offset + page.length;
        return {
          data: page.map((thread) => localThreadSummary(thread, this.context())),
          nextCursor: next < all.length ? String(next) : null,
          partial: false,
          diagnostics: [],
        };
      },
      'thread/loaded/list': () => {
        const run = port.run();
        return { data: run.threadId ? [run.threadId] : [] };
      },
      'bridge/thread/list/stream/start': (params) => {
        const streamId = readParam(params, 'streamId');
        if (!streamId) {
          throw new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'streamId is required', {
            error: 'on_device_failed',
          });
        }
        const data = port.threads().map((thread) => localThreadSummary(thread, this.context()));
        void Promise.resolve().then(() =>
          this.publish({
            method: 'bridge/thread/list/stream/batch',
            params: { streamId, limit: Math.max(1, data.length), data, done: true },
          }),
        );
        return { streamId, started: true };
      },
      'bridge/thread/list/stream/cancel': () => ({ ok: true }),
      'thread/read': (params) => {
        const thread = this.requireThread(params);
        return {
          thread:
            params['includeTurns'] === false
              ? localThreadSummary(thread, this.context())
              : this.snapshot(thread),
        };
      },
      'thread/start': async (params) => ({
        thread: this.snapshot(await this.createThread(params, null)),
      }),
      'bridge/thread/create': async (params) => {
        const submissionId = readParam(params, 'submissionId');
        const thread = await this.createThread(readRecord(params['threadStart']), submissionId);
        return { submissionId: submissionId ?? '', thread: this.snapshot(thread) };
      },
      'thread/name/update': async (params) => {
        const thread = this.requireThread(params);
        const title = readParam(params, 'title');
        if (!title) {
          throw new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'Enter a chat title.', {
            error: 'on_device_failed',
          });
        }
        return { thread: this.snapshot(await port.updateThread(thread.id, { title })) };
      },
      'thread/delete': async (params) => {
        const thread = this.requireThread(params);
        await port.deleteThread(thread.id);
        return { ok: true, threadId: thread.id };
      },
      'thread/config/set': async (params) => {
        const thread = this.requireThread(params);
        const model = this.availableModel(
          typeof params['value'] === 'string' ? params['value'] : null,
        );
        if (readParam(params, 'configId') !== LOCAL_MODEL_CONFIG_ID || !model) {
          throw new LocalRpcError(
            LOCAL_RPC_ERROR.invalidParams,
            'Choose a downloaded model for On this iPhone.',
            { error: 'on_device_model_required' },
          );
        }
        return { thread: this.snapshot(await port.chooseModel(thread.id, model)) };
      },
      'thread/resume': async (params) => {
        let thread = this.requireThread(params);
        const workspaceId = await this.workspaceForPath(readParam(params, 'cwd'));
        if (workspaceId && workspaceId !== thread.workspaceId) {
          if (thread.messages.length > 0) {
            throw new LocalRpcError(
              LOCAL_RPC_ERROR.invalidParams,
              'Start a new chat to use a different workspace.',
              { error: 'on_device_workspace_required' },
            );
          }
          thread = await port.updateThread(thread.id, { workspaceId });
        }
        await this.applyTurnModel(thread, params);
        const latest = port.thread(thread.id) ?? thread;
        return { thread: this.snapshot(latest), model: latest.modelId, reasoningEffort: null };
      },
      'turn/start': async (params) => {
        const thread = this.requireThread(params);
        await this.applyTurnModel(thread, params);
        const submissionId = readParam(params, 'submissionId') ?? `turn-${Date.now().toString(36)}`;
        const turnId = await this.startTurn(
          port.thread(thread.id) ?? thread,
          inputText(params),
          submissionId,
        );
        return { turn: { id: turnId } };
      },
      'turn/interrupt': async (params) => {
        const thread = this.requireThread(params);
        if (port.run().threadId === thread.id) {
          await port.stop();
        }
        return { ok: true };
      },
      [LOCAL_TURN_RETRY_METHOD]: async (params) => {
        const thread = this.requireThread(params);
        return { turn: { id: await startLocalRetry(port, thread) } };
      },
      'bridge/thread/queue/send': async (params) => {
        const thread = this.requireThread(params);
        const submissionId =
          readParam(params, 'submissionId') ?? `queue-${Date.now().toString(36)}`;
        const turnStart = readRecord(params['turnStart']);
        await this.applyTurnModel(thread, turnStart);
        const content =
          typeof params['content'] === 'string' ? params['content'] : inputText(turnStart);
        const turnId = await this.startTurn(
          port.thread(thread.id) ?? thread,
          content,
          submissionId,
        );
        return {
          submissionId,
          disposition: 'sent',
          turnId,
          queue: emptyQueue(thread.id),
        };
      },
      'bridge/thread/queue/read': (params) => emptyQueue(readParam(params, 'threadId') ?? ''),
      'bridge/thread/schedules/read': (params) => ({
        threadId: readParam(params, 'threadId') ?? '',
        schedules: [],
      }),
      'model/list': () => ({
        data: localModelListEntries(port.modelChoices(), this.defaultModel()),
      }),
      'bridge/workspaces/list': async () => {
        await port.refreshWorkspaces();
        return this.workspaceList();
      },
      'bridge/fs/list': async (params) => {
        await port.refreshWorkspaces();
        return this.filesystemList(readParam(params, 'path'));
      },
      'bridge/approvals/list': () => this.approvals.list(),
      'bridge/approvals/resolve': (params) => this.approvals.resolve(params),
      'bridge/userInput/list': () => [],
      ...createLocalGitHandlers(port, (params) => this.gitWorkspace(params)),
      ...createLocalWorkspaceHandlers(port, (params) => this.gitWorkspace(params)),
    };
    return handlers;
  }
}
