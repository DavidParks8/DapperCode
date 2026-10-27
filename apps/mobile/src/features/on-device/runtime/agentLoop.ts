import { randomUUID } from 'expo-crypto';
import type { LocalModelMessage, LocalModelReply } from '../models/engine';
import { LocalModelInterrupted } from '../models/session';
import type { LocalModelSession } from '../models/session';
import type { LocalThreadRepository } from './threads';
import { recoverLocalThread } from './threadCodec';
import type { LocalMessage, LocalThread, LocalToolCall } from './types';

export interface LocalRunSnapshot {
  phase: 'idle' | 'preparing' | 'generating' | 'tool' | 'stopping' | 'persisting';
  threadId: string | null;
  turnId: string | null;
  toolName: string | null;
}

interface Run {
  threadId: string;
  workspaceId: string;
  modelId: string;
  turnId: string;
  stopped: boolean;
  promise: Promise<LocalThread> | null;
}

export type LocalToolExecutor = (
  workspaceId: string,
  name: string,
  args: unknown,
) => Promise<unknown>;
type ModelPort = Pick<LocalModelSession, 'snapshot' | 'load' | 'generate' | 'stop'>;

export const LOCAL_AGENT_SYSTEM_PROMPT =
  'You are an offline coding agent on an iPhone. You may use only the listed tools in the selected workspace. ' +
  'There is no shell, package manager, or test runner. Never claim to have run unavailable commands. ' +
  'Inspect files before editing. Tool results are JSON objects; use their content and revision fields. ' +
  'Respect truncation and nextOffset. Do not guess file contents or report success without tool evidence.';

class LocalStepLimit extends Error {}

export class LocalAgentLoop {
  private active: Run | null = null;
  private value: LocalRunSnapshot = { phase: 'idle', threadId: null, turnId: null, toolName: null };

  constructor(
    private readonly threads: LocalThreadRepository,
    private readonly model: ModelPort,
    private readonly definitions: object[],
    private readonly execute: LocalToolExecutor,
    private readonly changed: (value: LocalRunSnapshot) => void,
  ) {}

  snapshot(): LocalRunSnapshot {
    return this.value;
  }

  send(
    id: string,
    input: string,
    submissionId: string,
    accepted?: () => void,
  ): Promise<LocalThread> {
    const thread = this.threads.get(id);
    if (
      thread.messages.some(
        (message) => message.role === 'user' && message.id === `user-${submissionId}`,
      )
    ) {
      return this.active?.threadId === id &&
        thread.lastSubmissionId === submissionId &&
        this.active.promise
        ? this.active.promise
        : Promise.resolve(thread);
    }
    if (this.active) {
      return Promise.reject(
        new Error('Stop the active local conversation before starting another run.'),
      );
    }
    if (!input.trim() || input.length > 100_000 || !submissionId) {
      return Promise.reject(new Error('Enter a message of at most 100000 characters.'));
    }
    const run: Run = {
      threadId: id,
      workspaceId: thread.workspaceId,
      modelId: thread.modelId,
      turnId: randomUUID(),
      stopped: false,
      promise: null,
    };
    this.active = run;
    run.promise = this.perform(run, input, submissionId, accepted);
    return run.promise;
  }

  async stop(): Promise<void> {
    const run = this.active;
    if (!run) {
      return;
    }
    run.stopped = true;
    this.publish(run, 'stopping');
    await this.model.stop();
    if (run.promise) {
      await run.promise;
    }
  }

  private async perform(
    run: Run,
    input: string,
    submissionId: string,
    accepted?: () => void,
  ): Promise<LocalThread> {
    try {
      this.publish(run, 'preparing');
      const now = new Date().toISOString();
      this.threads.change(run.threadId, (thread) => ({
        ...thread,
        status: 'running',
        activeTurnId: run.turnId,
        lastSubmissionId: submissionId,
        lastError: null,
        updatedAt: now,
        title: thread.messages.length === 0 ? input.trim().slice(0, 60) : thread.title,
        messages: [
          ...thread.messages,
          { id: `user-${submissionId}`, role: 'user', content: input, createdAt: now },
        ],
      }));
      await this.threads.save(run.threadId);
      accepted?.();
      this.checkStopped(run);
      const model = this.model.snapshot();
      if (model.modelId !== run.modelId || model.phase !== 'ready') {
        await this.model.load(run.modelId);
      }
      await this.rounds(run);
      return await this.settle(run, 'complete', null);
    } catch (error) {
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
        this.value = { phase: 'idle', threadId: null, turnId: null, toolName: null };
        this.changed(this.value);
      }
    }
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
      const reply = await this.model.generate(
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
        .messages.filter((message) => message.id !== pendingAssistantId)
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
  ): void {
    this.value = { phase, threadId: run.threadId, turnId: run.turnId, toolName };
    this.changed(this.value);
  }
}
