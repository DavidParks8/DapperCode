import { randomUUID } from 'expo-crypto';
import type { ApprovalPolicy, ChatToolKind } from '@bridge/types/types';
import { LocalModelInterrupted } from '../models/session';
import type { LocalModelSession } from '../models/session';
import { recoverLocalThread } from './threadCodec';
import { retryableLocalMessages } from './modelHistory';
import type {
  LocalMessage,
  LocalThread,
  LocalToolCall,
  LocalAgentRun as Run,
  LocalRunSnapshot,
  LocalToolExecutor,
  LocalToolApprovalPolicy,
} from './types';
import type { LocalToolPermission } from './toolDefinition';
import { localAgentSystemPrompt } from './systemPrompt';
import type { LocalWorkspaceGuidance } from './workspaceGuidance';
import { performLocalTool, updateLocalToolStatus } from './toolRunner';
import { LocalInferenceScheduler } from './inferenceScheduler';
import {
  CHILD_OUTPUT_TOKENS,
  CHILD_ROUNDS,
  EXPLORE_TOOLS,
  localRunSnapshot,
  delegateLocalChildren,
  readChild,
  type LocalThreadPort,
} from './delegation';
import { IDLE_LOCAL_RUN as IDLE } from './types';
import {
  localConversationTitle,
  LocalStepLimit,
  interruptLocalRun,
  runLocalRounds,
} from './agentPolicy';

export { retryableLocalMessages } from './modelHistory';
export {
  localConversationTitle,
  REPEATED_TOOL_CALL_LIMIT,
  repeatedToolCallError,
} from './agentPolicy';
export type {
  LocalRunSnapshot,
  LocalToolApproval,
  LocalToolExecutor,
  LocalToolApprovalPolicy,
} from './types';
import { executeWithToolOutput } from './toolArtifacts';
import { localConversationContext } from './contextMemory';
type ModelPort = Pick<LocalModelSession, 'snapshot' | 'load' | 'generate' | 'stop'>;

import {
  executeInteractionTool,
  isInteractionTool,
  resolveLocalInput,
  localTaskPrompt,
  type LocalInputReply,
} from './interactionTools';
export class LocalAgentLoop {
  private active: Run | null = null;
  private value: LocalRunSnapshot = IDLE;
  private approvalPolicy: ApprovalPolicy = 'untrusted';
  private readonly scheduler: LocalInferenceScheduler;
  private readonly children = new Set<LocalAgentLoop>();

  constructor(
    private readonly threads: LocalThreadPort,
    private readonly model: ModelPort,
    private readonly definitions: object[],
    private readonly execute: LocalToolExecutor,
    private readonly changed: (value: LocalRunSnapshot) => void,
    private readonly approval: LocalToolApprovalPolicy,
    private readonly today: () => Date = () => new Date(),
    private readonly guidance?: LocalWorkspaceGuidance,
    private readonly childAgent?: 'explore' | 'general',
    scheduler?: LocalInferenceScheduler,
  ) {
    this.scheduler = scheduler ?? new LocalInferenceScheduler(model);
  }

  snapshot(): LocalRunSnapshot {
    return this.value;
  }

  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy;
    for (const child of this.children) {
      child.setApprovalPolicy(policy);
    }
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
    for (const child of this.children) {
      if (child.snapshot().approval?.callId === callId) {
        child.resolveApproval(callId, approved);
        return;
      }
    }
    const pending = this.active?.approval;
    if (!pending || pending.callId !== callId) {
      throw new Error('This approval request is no longer pending.');
    }
    pending.resolve(approved);
  }

  resolveUserInput(requestId: string, reply: LocalInputReply): void {
    for (const child of this.children) {
      if (child.snapshot().userInput?.requestId === requestId) {
        child.resolveUserInput(requestId, reply);
        return;
      }
    }
    const run = this.active;
    resolveLocalInput(run, requestId, reply, () => {
      if (run) {
        this.publish(run, 'tool', 'ask_user');
      }
    });
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
    const children = [...this.children].map((child) => child.stop());
    if (!this.childAgent) {
      await this.model.stop();
    }
    await Promise.allSettled(children);
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
      guidance: { directories: new Set(['']), rules: '' },
      childAdmissions: 0,
      input: null,
    };
    this.active = run;
    return run;
  }

  private async perform(run: Run, begin: () => Promise<void>): Promise<LocalThread> {
    let started = false;
    try {
      this.publish(run, 'preparing');
      const model = this.model.snapshot();
      if (this.childAgent && model.modelId !== run.modelId) {
        throw new Error('The resident model changed; child work cannot switch models.');
      }
      if (!this.childAgent && (model.modelId !== run.modelId || model.phase !== 'ready')) {
        await interruptLocalRun(run, this.model.load(run.modelId));
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

  private async rounds(run: Run): Promise<void> {
    return runLocalRounds(this.threads, run, this.childAgent ? CHILD_ROUNDS : 32, {
      check: () => this.checkStopped(run),
      tool: (call, repeated) => this.tool(run, call, repeated),
      approval: this.approval,
      generate: async (assistantId) => {
        this.publish(run, 'generating');
        const context = await interruptLocalRun(run, this.modelContext(run, assistantId));
        return this.scheduler.generate(
          run.controller.signal,
          context.messages,
          this.definitions,
          (update) => {
            if (this.active !== run || run.stopped) {
              return;
            }
            this.message(run.threadId, assistantId, (message) => ({
              ...message,
              content: update.content,
              reasoning: update.reasoning,
            }));
          },
          { ...context.options, ...(this.childAgent ? { outputTokens: CHILD_OUTPUT_TOKENS } : {}) },
        );
      },
    });
  }

  private tool(run: Run, call: LocalToolCall, repeated: boolean): Promise<void> {
    return performLocalTool(this.threads, run, call, repeated, {
      permission: this.approval,
      allows: (kind) => this.automaticallyApproves(kind),
      approve: (id, permission) => this.approved(run, call, id, permission),
      validate: (name) => {
        if (
          this.childAgent &&
          (name === 'task' ||
            name === 'read_child' ||
            (this.childAgent === 'explore' && !EXPLORE_TOOLS.has(name)))
        ) {
          throw new Error('Not run: this child is read-only or requested recursive delegation.');
        }
      },
      execute: (name, args, id) => this.executeTool(run, name, args, id, call.id),
      started: () => this.publish(run, 'tool', call.function.name),
      check: () => this.checkStopped(run),
      outputLimit: this.childAgent ? 8192 : undefined,
    });
  }

  private async executeTool(
    run: Run,
    name: string,
    args: unknown,
    id: string,
    callId: string,
  ): Promise<unknown> {
    if (this.guidance) {
      await interruptLocalRun(
        run,
        this.guidance.beforeTool(run.workspaceId, run.guidance, name, args, run.controller.signal),
      );
      this.checkStopped(run);
    }
    const dispatch: LocalToolExecutor = async (workspace, tool, input, signal, offload) => {
      if (isInteractionTool(tool)) {
        return executeInteractionTool(
          this.threads,
          run,
          {
            id: callId,
            type: 'function',
            function: { name: tool, arguments: JSON.stringify(input) },
          },
          input,
          () => this.publish(run, 'input', tool),
        );
      }
      if (tool === 'read_child') {
        return readChild(
          {
            ...this.threads.get(run.threadId),
            workspaceId: run.workspaceId,
            modelId: run.modelId,
          },
          input,
        );
      }
      if (tool === 'task') {
        const result = await this.delegate(run, id, input);
        this.checkStopped(run);
        return result;
      }
      return this.execute(workspace, tool, input, signal, offload);
    };
    const result: unknown = JSON.parse(
      await executeWithToolOutput(
        this.threads.artifacts,
        { ...this.threads.get(run.threadId), workspaceId: run.workspaceId },
        name,
        args,
        run.controller.signal,
        dispatch,
      ),
    );
    return result;
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
      updateLocalToolStatus(
        this.threads,
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

  private async modelContext(
    run: Run,
    pendingAssistantId: string,
  ): Promise<ReturnType<typeof localConversationContext>> {
    const guidance = await this.guidance?.prompt(
      run.workspaceId,
      run.guidance,
      this.model.snapshot().contextTokens ?? 8192,
      run.controller.signal,
    );
    this.checkStopped(run);
    const today = this.today();
    const tasks = this.threads.get(run.threadId).tasks ?? [];
    const context =
      (guidance?.content ?? '') +
      localTaskPrompt(tasks, this.model.snapshot().contextTokens ?? 8192);
    return localConversationContext(
      this.threads,
      run.threadId,
      pendingAssistantId,
      (memory) => localAgentSystemPrompt(run.modelId, today, this.childAgent, context + memory),
      () => this.checkStopped(run),
      (phase) => this.publish(run, phase),
    );
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
    approval: LocalRunSnapshot['approval'] = null,
  ): void {
    this.value = localRunSnapshot(
      run,
      phase,
      toolName,
      approval,
      this.value,
      [...this.children].map((child) => child.snapshot()),
    );
    this.changed(this.value);
  }

  private delegate(run: Run, messageId: string, input: unknown): Promise<object> {
    return delegateLocalChildren(
      this.threads,
      run,
      messageId,
      input,
      async (child, prompt, port) => {
        const definitions = this.definitions.filter((definition) => {
          const name = (definition as { function: { name: string } }).function.name;
          return (
            name !== 'task' &&
            name !== 'read_child' &&
            (child.agent !== 'explore' || EXPLORE_TOOLS.has(name))
          );
        });
        const loop = new LocalAgentLoop(
          port,
          this.model,
          definitions,
          this.execute,
          () => {
            if (this.active === run) {
              this.publish(run, run.stopped ? 'stopping' : 'tool', 'task');
            }
          },
          this.approval,
          this.today,
          this.guidance,
          child.agent,
          this.scheduler,
        );
        loop.setApprovalPolicy(this.approvalPolicy);
        this.children.add(loop);
        try {
          return await loop.send(child.id, prompt, randomUUID());
        } finally {
          this.children.delete(loop);
        }
      },
    );
  }
}
