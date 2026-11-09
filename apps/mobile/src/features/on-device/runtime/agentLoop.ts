import { randomUUID } from 'expo-crypto';
import type { ApprovalPolicy, ChatToolKind } from '@bridge/types/types';
import type { LocalModelReply } from '../models/engine';
import { LocalModelInterrupted } from '../models/session';
import type { LocalModelSession } from '../models/session';
import type { LocalThreadRepository } from './threads';
import { recoverLocalThread } from './threadCodec';
import { emptyLocalAnswer, retryableLocalMessages } from './modelHistory';
import type {
  LocalMessage,
  LocalThread,
  LocalToolCall,
  LocalToolApproval,
  LocalRunSnapshot,
  LocalToolExecutor,
  LocalToolApprovalPolicy,
} from './types';
import type { LocalToolPermission } from './toolDefinition';
import { localAgentSystemPrompt } from './systemPrompt';
import { executeWithToolOutput, LocalArtifactStorageError } from './toolArtifacts';
import { localConversationContext } from './contextMemory';

export { retryableLocalMessages } from './modelHistory';
export type {
  LocalToolApproval,
  LocalRunSnapshot,
  LocalToolExecutor,
  LocalToolApprovalPolicy,
} from './types';

interface Run {
  threadId: string;
  workspaceId: string;
  modelId: string;
  turnId: string;
  submissionId: string | null;
  stopped: boolean;
  promise: Promise<LocalThread> | null;
  interrupt: Promise<never>;
  signalStop: () => void;
  controller: AbortController;
  approval: { callId: string; resolve: (approved: boolean | 'policy') => void } | null;
}

type ModelPort = Pick<LocalModelSession, 'snapshot' | 'load' | 'generate' | 'stop'>;

const IDLE: LocalRunSnapshot = {
  phase: 'idle',
  threadId: null,
  turnId: null,
  toolName: null,
  approval: null,
};

class LocalStepLimit extends Error {}

/**
 * Like opencode's doom-loop check: the same call this many times in a row is not run, and one more
 * repeat ends the turn.
 */
export const REPEATED_TOOL_CALL_LIMIT = 3;

export function repeatedToolCallError(name: string): string {
  return `Not run: this is the same ${name} call with the same arguments ${String(REPEATED_TOOL_CALL_LIMIT)} times in a row, so its result would not change. Use the earlier result, try a different tool or arguments, or answer.`;
}

const TITLE_LIMIT = 60;

/**
 * A conversation title from its first message: the first line, cut at a word boundary with an
 * ellipsis when it is longer than the drawer can show.
 */
export function localConversationTitle(input: string): string {
  const line = input.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  if (line.length <= TITLE_LIMIT) {
    return line || 'New local conversation';
  }
  const cut = line.slice(0, TITLE_LIMIT - 1);
  const boundary = cut.lastIndexOf(' ');
  const words = boundary >= TITLE_LIMIT / 2 ? cut.slice(0, boundary) : cut;
  return `${words.replace(/[\s.,;:!?-]+$/u, '')}…`;
}

export class LocalAgentLoop {
  private active: Run | null = null;
  private value: LocalRunSnapshot = IDLE;
  private approvalPolicy: ApprovalPolicy = 'untrusted';

  constructor(
    private readonly threads: LocalThreadRepository,
    private readonly model: ModelPort,
    private readonly definitions: object[],
    private readonly execute: LocalToolExecutor,
    private readonly changed: (value: LocalRunSnapshot) => void,
    private readonly approval: LocalToolApprovalPolicy,
    private readonly today: () => Date = () => new Date(),
  ) {}

  snapshot(): LocalRunSnapshot {
    return this.value;
  }

  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy;
    const pending = this.value.approval;
    if (!this.active?.stopped && pending && this.automaticallyApproves(pending.kind)) {
      this.active?.approval?.resolve('policy');
    }
  }

  private automaticallyApproves(kind: ChatToolKind): boolean {
    return (
      this.approvalPolicy === 'never' ||
      (this.approvalPolicy === 'on-request' && ['read', 'search', 'think'].includes(kind))
    );
  }

  /**
   * Starts a turn. The model is loaded before the message is recorded, so `accepted` (which should
   * clear the composer draft) runs only once the turn has truly started.
   */
  send(
    id: string,
    input: string,
    submissionId: string,
    accepted?: () => void,
  ): Promise<LocalThread> {
    const thread = this.threads.get(id);
    const active = this.active;
    if (active?.threadId === id && active.submissionId === submissionId && active.promise) {
      return active.promise;
    }
    if (
      thread.messages.some(
        (message) => message.role === 'user' && message.id === `user-${submissionId}`,
      )
    ) {
      return Promise.resolve(thread);
    }
    if (active) {
      return Promise.reject(
        new Error('Stop the active local conversation before starting another run.'),
      );
    }
    if (!input.trim() || input.length > 100_000 || !submissionId) {
      return Promise.reject(new Error('Enter a message of at most 100000 characters.'));
    }
    const run = this.createRun(thread, submissionId);
    run.promise = this.perform(run, async () => {
      const now = new Date().toISOString();
      this.threads.change(run.threadId, (current) => ({
        ...current,
        status: 'running',
        activeTurnId: run.turnId,
        lastSubmissionId: submissionId,
        lastError: null,
        updatedAt: now,
        title: current.messages.length === 0 ? localConversationTitle(input) : current.title,
        messages: [
          ...current.messages,
          { id: `user-${submissionId}`, role: 'user', content: input, createdAt: now },
        ],
      }));
      await this.threads.save(run.threadId);
      accepted?.();
    });
    return run.promise;
  }

  /** Resends or continues the last failed or interrupted user turn without replaying any tool. */
  retry(id: string): Promise<LocalThread> {
    if (this.active) {
      return Promise.reject(
        new Error('Stop the active local conversation before retrying another turn.'),
      );
    }
    const thread = this.threads.get(id);
    if (!retryableLocalMessages(thread)) {
      return Promise.reject(new Error('This conversation has no failed or stopped turn to retry.'));
    }
    const run = this.createRun(thread, null);
    run.promise = this.perform(run, async () => {
      this.threads.change(run.threadId, (current) => ({
        ...current,
        status: 'running',
        activeTurnId: run.turnId,
        lastError: null,
        updatedAt: new Date().toISOString(),
        messages: retryableLocalMessages(current) ?? current.messages,
      }));
      await this.threads.save(run.threadId);
    });
    return run.promise;
  }

  /** Approves or declines the pending tool call identified by `callId`. */
  resolveApproval(callId: string, approved: boolean): void {
    const pending = this.active?.approval;
    if (!pending || pending.callId !== callId) {
      throw new Error('This approval request is no longer pending.');
    }
    pending.resolve(approved);
  }

  async stop(): Promise<void> {
    const run = this.active;
    if (!run) {
      return;
    }
    run.stopped = true;
    this.publish(run, 'stopping');
    run.controller.abort();
    run.signalStop();
    await this.model.stop();
    if (run.promise) {
      await run.promise;
    }
  }

  private createRun(thread: LocalThread, submissionId: string | null): Run {
    let signalStop: () => void = () => undefined;
    const interrupt = new Promise<never>((_resolve, reject) => {
      signalStop = () => reject(new LocalModelInterrupted());
    });
    interrupt.catch(() => undefined);
    const run: Run = {
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      modelId: thread.modelId,
      turnId: randomUUID(),
      submissionId,
      stopped: false,
      promise: null,
      interrupt,
      signalStop,
      controller: new AbortController(),
      approval: null,
    };
    this.active = run;
    return run;
  }

  private async perform(run: Run, begin: () => Promise<void>): Promise<LocalThread> {
    let started = false;
    try {
      this.publish(run, 'preparing');
      const model = this.model.snapshot();
      if (model.modelId !== run.modelId || model.phase !== 'ready') {
        await this.interruptible(run, this.model.load(run.modelId));
      }
      this.checkStopped(run);
      started = true;
      await begin();
      this.checkStopped(run);
      await this.rounds(run);
      return await this.settle(run, 'complete', null);
    } catch (error) {
      if (!started) {
        return this.abandon(run, error);
      }
      if (run.stopped || error instanceof LocalModelInterrupted) {
        return this.settle(run, 'interrupted', 'Stopped. Completed edits are preserved.');
      }
      if (error instanceof LocalStepLimit) {
        return this.settle(run, 'interrupted', error.message);
      }
      const detail = error instanceof Error ? error.message : 'The local agent failed.';
      await this.settle(run, 'failed', detail);
      throw error;
    } finally {
      if (this.active === run) {
        this.active = null;
        this.value = IDLE;
        this.changed(this.value);
      }
    }
  }

  /** A turn that never started leaves history untouched so the unsent draft can be resent. */
  private abandon(run: Run, error: unknown): LocalThread {
    if (run.stopped || error instanceof LocalModelInterrupted) {
      return this.threads.get(run.threadId);
    }
    const detail = error instanceof Error ? error.message : 'The local model could not start.';
    this.threads.change(run.threadId, (thread) => ({ ...thread, lastError: detail }));
    throw error;
  }

  /** Stop settles the run promptly; the session releases work that finishes after the stop. */
  private interruptible<T>(run: Run, work: Promise<T>): Promise<T> {
    work.catch(() => undefined);
    return Promise.race([work, run.interrupt]);
  }

  private async rounds(run: Run): Promise<void> {
    let steps = 0;
    let lastCall = '';
    let repeats = 0;
    for (let round = 0; round < 32; round += 1) {
      this.checkStopped(run);
      const assistant: LocalMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };
      this.threads.change(run.threadId, (thread) => ({
        ...thread,
        messages: [...thread.messages, assistant],
      }));
      this.publish(run, 'generating');
      let reply: LocalModelReply;
      try {
        const context = localConversationContext(
          this.threads,
          run.threadId,
          assistant.id,
          localAgentSystemPrompt(run.modelId, this.today()),
          () => this.checkStopped(run),
          (phase) => this.publish(run, phase),
        );
        reply = await this.model.generate(
          context.messages,
          this.definitions,
          (update) => {
            if (this.active !== run || run.stopped) {
              return;
            }
            this.message(run.threadId, assistant.id, (message) => ({
              ...message,
              content: update.content,
              reasoning: update.reasoning,
            }));
          },
          context.options,
        );
      } catch (error) {
        this.threads.change(run.threadId, (thread) => ({
          ...thread,
          messages: thread.messages.filter(
            (message) => message.id !== assistant.id || !emptyLocalAnswer(message),
          ),
        }));
        throw error;
      }
      this.checkStopped(run);
      const calls = this.calls(reply);
      this.message(run.threadId, assistant.id, (message) => ({
        ...message,
        content: reply.content ?? '',
        reasoning: reply.reasoning_content ?? '',
        toolCalls: calls,
      }));
      await this.threads.save(run.threadId);
      if (calls.length === 0) {
        if (reply.truncated || reply.stopped_limit) {
          throw new LocalStepLimit(
            'The local model reached its output limit. Review the partial response and continue explicitly.',
          );
        }
        if (!reply.content?.trim()) {
          throw new Error('The model returned neither an answer nor a tool call.');
        }
        return;
      }
      for (const call of calls) {
        this.checkStopped(run);
        if (steps === 32) {
          throw new LocalStepLimit(
            'The local tool limit was reached. Review the workspace before continuing.',
          );
        }
        steps += 1;
        const key = `${call.function.name} ${call.function.arguments}`;
        repeats = key === lastCall ? repeats + 1 : 1;
        lastCall = key;
        if (repeats > REPEATED_TOOL_CALL_LIMIT) {
          throw new LocalStepLimit(
            `The local model kept repeating the same ${call.function.name} call. Review the conversation, then continue or rephrase the request.`,
          );
        }
        await this.tool(run, call, repeats === REPEATED_TOOL_CALL_LIMIT);
      }
    }
    throw new LocalStepLimit(
      'The local tool limit was reached. Review the workspace before continuing.',
    );
  }

  private async tool(run: Run, call: LocalToolCall, repeated: boolean): Promise<void> {
    const id = randomUUID();
    const tool: LocalMessage = {
      id,
      role: 'tool',
      content: '',
      createdAt: new Date().toISOString(),
      tool: {
        callId: call.id,
        name: call.function.name,
        status: 'pending',
        startedAt: new Date().toISOString(),
      },
    };
    this.threads.change(run.threadId, (thread) => ({
      ...thread,
      messages: [...thread.messages, tool],
    }));
    await this.threads.save(run.threadId);
    this.checkStopped(run);
    if (repeated) {
      const error = JSON.stringify({ error: repeatedToolCallError(call.function.name) });
      this.toolStatus(run.threadId, id, 'failed', error);
      await this.threads.save(run.threadId);
      return;
    }
    try {
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('The tool arguments were not valid JSON.');
        }
        throw error;
      }
      const permission = this.approval(call.function.name, args);
      if (
        permission &&
        !this.automaticallyApproves(permission.kind) &&
        !(await this.approved(run, call, id, permission))
      ) {
        this.toolStatus(
          run.threadId,
          id,
          'failed',
          JSON.stringify({
            error: `The user declined this request (${permission.summary}). It did not run. Do not retry it unless the user asks.`,
          }),
        );
        await this.threads.save(run.threadId);
        return;
      }
      this.checkStopped(run);
      this.publish(run, 'tool', call.function.name);
      this.toolStatus(run.threadId, id, 'running');
      const content = await executeWithToolOutput(
        this.threads.artifacts,
        { id: run.threadId, workspaceId: run.workspaceId },
        call.function.name,
        args,
        run.controller.signal,
        this.execute,
      );
      this.toolStatus(run.threadId, id, 'completed', content);
    } catch (error) {
      if (error instanceof LocalArtifactStorageError) {
        this.toolStatus(run.threadId, id, 'completed', JSON.stringify(error.result));
        await this.threads.save(run.threadId);
        throw error;
      }
      if (error instanceof LocalModelInterrupted) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : 'The local tool failed.';
      this.toolStatus(
        run.threadId,
        id,
        run.stopped ? 'interrupted' : 'failed',
        JSON.stringify({ error: detail }),
      );
      if (run.stopped) {
        throw error;
      }
    }
    await this.threads.save(run.threadId);
  }

  private async approved(
    run: Run,
    call: LocalToolCall,
    messageId: string,
    permission: LocalToolPermission,
  ): Promise<boolean> {
    try {
      while (true) {
        if (this.automaticallyApproves(permission.kind)) {
          return true;
        }
        const decision = new Promise<boolean | 'policy'>((resolve) => {
          run.approval = { callId: call.id, resolve };
        });
        this.publish(run, 'approval', call.function.name, {
          threadId: run.threadId,
          turnId: run.turnId,
          callId: call.id,
          toolName: call.function.name,
          ...permission,
        });
        const approved = await Promise.race([decision, run.interrupt]);
        this.checkStopped(run);
        if (approved !== 'policy') {
          return approved;
        }
      }
    } catch (error) {
      this.toolStatus(
        run.threadId,
        messageId,
        'interrupted',
        JSON.stringify({ error: 'Stopped before the user approved this request. It did not run.' }),
      );
      await this.threads.save(run.threadId);
      throw error;
    } finally {
      run.approval = null;
    }
  }

  private calls(reply: LocalModelReply): LocalToolCall[] {
    return (reply.tool_calls ?? []).map((call) => ({
      id: randomUUID(),
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }

  private message(
    id: string,
    messageId: string,
    update: (message: LocalMessage) => LocalMessage,
  ): void {
    this.threads.change(id, (thread) => ({
      ...thread,
      updatedAt: new Date().toISOString(),
      messages: thread.messages.map((message) =>
        message.id === messageId ? update(message) : message,
      ),
    }));
  }

  private toolStatus(
    id: string,
    messageId: string,
    status: NonNullable<LocalMessage['tool']>['status'],
    content?: string,
  ): void {
    this.message(id, messageId, (message) => {
      if (!message.tool) {
        throw new Error('The local tool invocation is missing.');
      }
      return {
        ...message,
        ...(content === undefined ? {} : { content }),
        tool: {
          ...message.tool,
          status,
          ...(status === 'running' ? {} : { completedAt: new Date().toISOString() }),
        },
      };
    });
  }

  private async settle(
    run: Run,
    status: LocalThread['status'],
    error: string | null,
  ): Promise<LocalThread> {
    this.publish(run, 'persisting');
    const thread = this.threads.change(run.threadId, (thread) => ({
      ...recoverLocalThread(thread),
      status,
      activeTurnId: null,
      lastError: error,
      updatedAt: new Date().toISOString(),
    }));
    await this.threads.save(run.threadId);
    return thread;
  }

  private checkStopped(run: Run): void {
    if (run.stopped || this.active !== run) {
      throw new LocalModelInterrupted();
    }
  }

  private publish(
    run: Run,
    phase: LocalRunSnapshot['phase'],
    toolName: string | null = null,
    approval: LocalToolApproval | null = null,
  ): void {
    this.value = { phase, threadId: run.threadId, turnId: run.turnId, toolName, approval };
    this.changed(this.value);
  }
}
