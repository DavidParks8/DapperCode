import {
  base64UrlUtf8,
  isFailedSubAgentState,
  isTerminalSubAgentState,
} from '@bridge/mapping/chatMappingPlanParsing';
import type { ChatActivityContent } from '@bridge/types/types';
import { localConversationTitle } from '../runtime/agentPolicy';
import { childEntries } from '../runtime/delegation';
import type { LocalChild, LocalThread } from '../runtime/types';
import { LOCAL_AGENT_ID, localChildLatest, localChildState } from './wire';

const CHILD_THREAD_PREFIX = `v1.${base64UrlUtf8(LOCAL_AGENT_ID)}.`;

/**
 * The thread a task child is presented as: the `v1.<agent>.<session>` id the bridge gives an ACP
 * sub-agent session, which is also what a snapshot's `<task id>` header resolves to.
 */
export function localChildThreadId(childId: string): string {
  return `${CHILD_THREAD_PREFIX}${base64UrlUtf8(childId)}`;
}

export function isLocalChildThreadId(threadId: string): boolean {
  return threadId.startsWith(CHILD_THREAD_PREFIX);
}

/** The parent's card for a child, shaped like the bridge's ACP sub-agent activity. */
export function childActivity(
  parentId: string,
  child: LocalChild,
): { id: string; content: ChatActivityContent } {
  const state = localChildState(child);
  const latest = localChildLatest(child);
  const heading = isFailedSubAgentState(state)
    ? '• Sub-agent failed'
    : isTerminalSubAgentState(state)
      ? '• Sub-agent completed'
      : '• Sub-agent working';
  return {
    id: `subagent:child:${parentId}:${child.id}`,
    content: {
      text: [heading, `  Status: ${state}`, ...(latest ? [`  Latest: ${latest}`] : [])].join('\n'),
      subAgent: {
        toolCallId: `child:${parentId}:${child.id}`,
        tool: 'spawnAgent',
        prompt: child.messages.find((entry) => entry.role === 'user')?.content,
        senderThreadId: parentId,
        receiverThreadIds: [localChildThreadId(child.id)],
        agentStatus: state,
      },
    },
  };
}

/** Child threads per child state; a child's state is replaced, never mutated, on each change. */
const projected = new WeakMap<LocalChild, LocalThread>();

/**
 * A task child as a read-only thread of its own, so the shell can open it and watch it work like
 * an ACP sub-agent session. Its turn is its latest prompt, so a resumed child starts a new run.
 */
export function localChildThread(parent: LocalThread, child: LocalChild): LocalThread {
  const cached = projected.get(child);
  if (cached?.parentThreadId === parent.id) {
    return cached;
  }
  const prompts = child.messages.filter((message) => message.role === 'user');
  const latest = prompts.at(-1);
  const thread: LocalThread = {
    version: 1,
    id: localChildThreadId(child.id),
    title: prompts[0]
      ? localConversationTitle(prompts[0].content)
      : `${child.agent === 'general' ? 'General' : 'Explore'} agent`,
    workspaceId: child.workspaceId,
    modelId: child.modelId,
    createdAt: child.messages[0]?.createdAt ?? child.updatedAt,
    updatedAt: child.updatedAt,
    status: child.status,
    activeTurnId: child.status === 'running' && latest ? latest.id : null,
    lastSubmissionId: latest ? latest.id.replace(/^user-/u, '') : null,
    lastError: child.lastError,
    messages: child.messages,
    parentThreadId: parent.id,
    agent: child.agent,
    ...(child.tasks ? { tasks: child.tasks } : {}),
  };
  projected.set(child, thread);
  return thread;
}

/** Every conversation, each followed by the child threads its task calls spawned. */
export function withLocalChildren(threads: readonly LocalThread[]): LocalThread[] {
  return threads.flatMap((parent) => [parent, ...childThreadsOf(parent)]);
}

/** Per parent state, so an unchanged conversation is not rescanned on every streamed token. */
const spawned = new WeakMap<LocalThread, readonly LocalThread[]>();

function childThreadsOf(parent: LocalThread): readonly LocalThread[] {
  let threads = spawned.get(parent);
  if (!threads) {
    threads = childEntries(parent).map((child) => localChildThread(parent, child));
    spawned.set(parent, threads);
  }
  return threads;
}

export function findLocalChildThread(
  threads: readonly LocalThread[],
  threadId: string,
): LocalThread | null {
  if (!isLocalChildThreadId(threadId)) {
    return null;
  }
  for (const parent of threads) {
    const child = childThreadsOf(parent).find((entry) => entry.id === threadId);
    if (child) {
      return child;
    }
  }
  return null;
}
