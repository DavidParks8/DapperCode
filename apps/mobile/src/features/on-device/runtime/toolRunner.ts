import { randomUUID } from 'expo-crypto';
import type { ChatToolKind } from '@bridge/types/types';
import { LocalModelInterrupted } from '../models/session';
import { repeatedToolCallError } from './agentPolicy';
import { LocalArtifactStorageError } from './toolArtifacts';
import type { LocalThreadPort } from './delegation';
import type { LocalToolPermission } from './toolDefinition';
import type {
  LocalAgentRun,
  LocalMessage,
  LocalToolApproval,
  LocalToolApprovalPolicy,
  LocalToolCall,
} from './types';

export const STOPPED_BEFORE_APPROVAL =
  'Stopped before the user approved this request. It did not run. Do not retry it unless the user asks.';

export function updateLocalToolStatus(
  threads: LocalThreadPort,
  threadId: string,
  messageId: string,
  status: NonNullable<LocalMessage['tool']>['status'],
  content?: string,
): void {
  threads.change(threadId, (thread) => ({
    ...thread,
    updatedAt: new Date().toISOString(),
    messages: thread.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }
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
    }),
  }));
}

function argumentsOf(call: LocalToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    throw new Error('The tool arguments were not valid JSON.');
  }
}

function resultJson(result: unknown, limit: number | undefined): string {
  const content = JSON.stringify(result);
  if (content === undefined) {
    throw new Error('The local tool returned no JSON result.');
  }
  return limit !== undefined && content.length > limit
    ? JSON.stringify({ truncated: true, content: content.slice(0, limit) })
    : content;
}

/** Shared tool lifecycle for the parent and children; intent is durable before dispatch. */
export async function performLocalTool(
  threads: LocalThreadPort,
  run: LocalAgentRun,
  call: LocalToolCall,
  repeated: boolean,
  bindings: {
    permission: LocalToolApprovalPolicy;
    /** Policy or a run-scoped skill pre-approval (`allowed-tools`) skips the prompt. */
    allows: (kind: ChatToolKind, name: string) => boolean;
    approve: (messageId: string, permission: LocalToolPermission) => Promise<boolean>;
    validate: (name: string) => void;
    execute: (name: string, args: unknown, messageId: string) => Promise<unknown>;
    started: () => void;
    check: () => void;
    outputLimit?: number;
  },
): Promise<void> {
  const id = randomUUID();
  const now = new Date().toISOString();
  threads.change(run.threadId, (thread) => ({
    ...thread,
    messages: [
      ...thread.messages,
      {
        id,
        role: 'tool',
        content: '',
        createdAt: now,
        tool: { callId: call.id, name: call.function.name, status: 'pending', startedAt: now },
      },
    ],
  }));
  await threads.save(run.threadId);
  bindings.check();
  if (repeated) {
    updateLocalToolStatus(
      threads,
      run.threadId,
      id,
      'failed',
      JSON.stringify({ error: repeatedToolCallError(call.function.name) }),
    );
    await threads.save(run.threadId);
    return;
  }
  try {
    const args = argumentsOf(call);
    bindings.validate(call.function.name);
    const permission = bindings.permission(call.function.name, args);
    if (
      permission &&
      !bindings.allows(permission.kind, call.function.name) &&
      !(await bindings.approve(id, permission))
    ) {
      updateLocalToolStatus(
        threads,
        run.threadId,
        id,
        'failed',
        JSON.stringify({
          error: `The user declined this request (${permission.summary}). It did not run. Do not retry it unless the user asks.`,
        }),
      );
      await threads.save(run.threadId);
      return;
    }
    bindings.check();
    bindings.started();
    updateLocalToolStatus(threads, run.threadId, id, 'running');
    const result = await bindings.execute(call.function.name, args, id);
    updateLocalToolStatus(
      threads,
      run.threadId,
      id,
      'completed',
      // Skill pages are already bounded and must reach the model whole.
      resultJson(result, call.function.name === 'skill' ? undefined : bindings.outputLimit),
    );
  } catch (error) {
    if (error instanceof LocalArtifactStorageError) {
      updateLocalToolStatus(threads, run.threadId, id, 'completed', JSON.stringify(error.result));
      await threads.save(run.threadId);
      throw error;
    }
    if (error instanceof LocalModelInterrupted) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : 'The local tool failed.';
    updateLocalToolStatus(
      threads,
      run.threadId,
      id,
      run.stopped ? 'interrupted' : 'failed',
      JSON.stringify({ error: detail }),
    );
    if (run.stopped) {
      throw error;
    }
  }
  await threads.save(run.threadId);
}

/** Waits for the user's decision, re-checking policy changes; a stop marks the call interrupted. */
export async function awaitLocalApproval(
  threads: LocalThreadPort,
  run: LocalAgentRun,
  call: LocalToolCall,
  messageId: string,
  permission: LocalToolPermission,
  bindings: {
    automatic: () => boolean;
    publish: (approval: LocalToolApproval) => void;
    check: () => void;
  },
): Promise<boolean> {
  try {
    while (true) {
      if (bindings.automatic()) {
        return true;
      }
      const decision = new Promise<boolean | 'policy'>((resolve) => {
        run.approval = { callId: call.id, resolve };
      });
      bindings.publish({
        threadId: run.threadId,
        turnId: run.turnId,
        callId: call.id,
        toolName: call.function.name,
        ...permission,
      });
      const approved = await Promise.race([decision, run.interrupt]);
      bindings.check();
      if (approved !== 'policy') {
        return approved;
      }
    }
  } catch (error) {
    updateLocalToolStatus(
      threads,
      run.threadId,
      messageId,
      'interrupted',
      JSON.stringify({ error: STOPPED_BEFORE_APPROVAL }),
    );
    await threads.save(run.threadId);
    throw error;
  } finally {
    run.approval = null;
  }
}
