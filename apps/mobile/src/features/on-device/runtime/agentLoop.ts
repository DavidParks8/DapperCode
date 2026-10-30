import { randomUUID } from 'expo-crypto';
import type { LocalModelMessage, LocalModelReply } from '../models/engine';
import { LocalModelInterrupted } from '../models/session';
import type { LocalModelSession } from '../models/session';
import type { LocalThreadRepository } from './threads';
import { recoverLocalThread } from './threadCodec';
import type { LocalMessage, LocalThread, LocalToolCall } from './types';

/** A model tool call waiting for an explicit user decision before it may run. */
export interface LocalToolApproval {
  threadId: string;
  turnId: string;
  callId: string;
  toolName: string;
  summary: string;
}

export interface LocalRunSnapshot {
  phase: 'idle' | 'preparing' | 'generating' | 'tool' | 'approval' | 'stopping' | 'persisting';
  threadId: string | null;
  turnId: string | null;
  toolName: string | null;
  approval: LocalToolApproval | null;
}

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
  approval: { callId: string; resolve: (approved: boolean) => void } | null;
}

export type LocalToolExecutor = (
  workspaceId: string,
  name: string,
  args: unknown,
) => Promise<unknown>;
/** Returns a user-facing summary when a tool needs explicit approval, otherwise null. */
export type LocalToolApprovalPolicy = (name: string) => string | null;
type ModelPort = Pick<LocalModelSession, 'snapshot' | 'load' | 'generate' | 'stop'>;

export const LOCAL_AGENT_SYSTEM_PROMPT =
  'You are an offline coding agent on an iPhone. You may use only the listed tools in the selected workspace. ' +
  'There is no shell, package manager, or test runner. Never claim to have run unavailable commands. ' +
  'Inspect files before editing. Tool results are JSON objects; use their content and revision fields. ' +
  'Respect truncation and nextOffset, and read large files in small chunks. Results marked elided were ' +
  'removed to save context; call the tool again if you need them. Some tools need user approval; if one ' +
  'is declined, do not retry it unless asked. Do not guess file contents or report success without tool evidence.';

const IDLE: LocalRunSnapshot = {
  phase: 'idle',
  threadId: null,
  turnId: null,
  toolName: null,
  approval: null,
};

class LocalStepLimit extends Error {}

/**
 * The history a retry continues from, or null when the thread has no failed or interrupted turn.
 * Answer-only attempts after the last tool activity (or the user message) are regenerated. Tool
 * calls and their recorded results are kept so the model continues from them; tools are never
 * replayed.
 */
export function retryableLocalMessages(thread: LocalThread): LocalMessage[] | null {
  if (thread.status !== 'failed' && thread.status !== 'interrupted') {
    return null;
  }
  let lastUser = -1;
  thread.messages.forEach((message, index) => {
    if (message.role === 'user') {
      lastUser = index;
    }
  });
  if (lastUser < 0) {
    return null;
  }
  const turn = thread.messages.slice(lastUser + 1);
  let lastToolActivity = -1;
  turn.forEach((message, index) => {
    if (message.role === 'tool' || message.toolCalls?.length) {
      lastToolActivity = index;
    }
  });
  // A partial or truncated final answer after the last tool activity is regenerated, not kept.
  return [
    ...thread.messages.slice(0, lastUser + 1),
    ...turn.slice(0, lastToolActivity + 1).filter((message) => !emptyAnswer(message)),
  ];
}

function emptyAnswer(message: LocalMessage): boolean {
  return message.role === 'assistant' && !message.content.trim() && !message.toolCalls?.length;
}

export class LocalAgentLoop {
  private active: Run | null = null;
  private value: LocalRunSnapshot = IDLE;

  constructor(
    private readonly threads: LocalThreadRepository,
    private readonly model: ModelPort,
    private readonly definitions: object[],
    private readonly execute: LocalToolExecutor,
    private readonly changed: (value: LocalRunSnapshot) => void,
    private readonly approval: LocalToolApprovalPolicy = () => null,
  ) {}

  snapshot(): LocalRunSnapshot {
    return this.value;
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
        title: current.messages.length === 0 ? input.trim().slice(0, 60) : current.title,
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
        reply = await this.model.generate(
          this.modelMessages(run.threadId, assistant.id),
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
        );
      } catch (error) {
        this.threads.change(run.threadId, (thread) => ({
          ...thread,
          messages: thread.messages.filter(
            (message) => message.id !== assistant.id || !emptyAnswer(message),
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
        await this.tool(run, call);
      }
    }
    throw new LocalStepLimit(
      'The local tool limit was reached. Review the workspace before continuing.',
    );
  }

  private async tool(run: Run, call: LocalToolCall): Promise<void> {
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
    const summary = this.approval(call.function.name);
    if (summary && !(await this.approved(run, call, id, summary))) {
      this.toolStatus(
        run.threadId,
        id,
        'failed',
        JSON.stringify({
          error: `The user declined this request (${summary}). It did not run. Do not retry it unless the user asks.`,
        }),
      );
      await this.threads.save(run.threadId);
      return;
    }
    this.publish(run, 'tool', call.function.name);
    this.toolStatus(run.threadId, id, 'running');
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
      const result = await this.execute(run.workspaceId, call.function.name, args);
      const content = JSON.stringify(result);
      if (content === undefined) {
        throw new Error('The local tool returned no JSON result.');
      }
      this.toolStatus(run.threadId, id, 'completed', content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The local tool failed.';
      this.toolStatus(run.threadId, id, 'failed', JSON.stringify({ error: detail }));
    }
    await this.threads.save(run.threadId);
  }

  private async approved(
    run: Run,
    call: LocalToolCall,
    messageId: string,
    summary: string,
  ): Promise<boolean> {
    const decision = new Promise<boolean>((resolve) => {
      run.approval = { callId: call.id, resolve };
    });
    this.publish(run, 'approval', call.function.name, {
      threadId: run.threadId,
      turnId: run.turnId,
      callId: call.id,
      toolName: call.function.name,
      summary,
    });
    try {
      const approved = await Promise.race([decision, run.interrupt]);
      this.checkStopped(run);
      return approved;
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

  private modelMessages(id: string, pendingAssistantId: string): LocalModelMessage[] {
    return [
      { role: 'system', content: LOCAL_AGENT_SYSTEM_PROMPT },
      ...this.threads
        .get(id)
        .messages.filter((message) => message.id !== pendingAssistantId && !emptyAnswer(message))
        .map((message): LocalModelMessage => ({
          role: message.role,
          content: message.content,
          ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
          ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
          ...(message.tool ? { name: message.tool.name, tool_call_id: message.tool.callId } : {}),
        })),
    ];
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
