import { randomUUID } from 'expo-crypto';
import { argumentsRecord, integer, text } from './toolArguments';
import { toolDefinition } from './toolDefinition';
import type { LocalChild, LocalMessage, LocalThread } from './types';
import type { LocalRunSnapshot } from './types';
import type { LocalAgentRun, LocalToolApprovalPolicy, LocalToolCall } from './types';
import type { LocalThreadRepository } from './threads';

export type LocalThreadPort = Pick<
  LocalThreadRepository,
  'get' | 'change' | 'save' | 'flush' | 'artifacts'
>;
export const LOCAL_FANOUT = 3;
export const CHILD_ROUNDS = 8;
export const CHILD_OUTPUT_TOKENS = 512;
export const CHILD_RESULT_CHARS = 2048;

/** Explicit allowlist: unknown/new tools cannot silently acquire read-only child privileges. */
export const PARALLEL_READ_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob_files',
  'git_status',
  'git_diff',
  'git_history',
  'skill',
  'code_diagnostics',
  'code_definitions',
  'code_references',
  'code_symbols',
  'read_tool_output',
  'search_tool_output',
  'todo_read',
]);
export const EXPLORE_TOOLS = new Set([
  ...PARALLEL_READ_TOOLS,
  'web_fetch',
  'web_search',
  'ask_user',
  'todo_write',
]);

export function localChildInteractions(
  snapshots: readonly LocalRunSnapshot[],
  previous: LocalRunSnapshot,
) {
  const approvals = snapshots.flatMap((snapshot) => (snapshot.approval ? [snapshot.approval] : []));
  const questions = snapshots.flatMap((snapshot) =>
    snapshot.userInput ? [snapshot.userInput] : [],
  );
  return {
    approval:
      approvals.find((pending) => pending.callId === previous.approval?.callId) ?? approvals[0],
    userInput:
      questions.find((pending) => pending.requestId === previous.userInput?.requestId) ??
      questions[0],
  };
}

function keepVisibleApproval(
  approval: NonNullable<LocalRunSnapshot['approval']>,
  previous: LocalRunSnapshot,
): boolean {
  return previous.approval?.callId === approval.callId && !previous.userInput;
}

export function localRunSnapshot(
  run: LocalAgentRun,
  phase: LocalRunSnapshot['phase'],
  toolName: string | null,
  approval: LocalRunSnapshot['approval'],
  previous: LocalRunSnapshot,
  children: readonly LocalRunSnapshot[],
): LocalRunSnapshot {
  let userInput = !run.stopped ? (run.input?.request ?? null) : null;
  if (!run.stopped && !approval) {
    const selected = localChildInteractions(children, previous);
    if (selected.approval) {
      approval = { ...selected.approval, threadId: run.threadId, turnId: run.turnId };
      phase = 'approval';
      toolName = selected.approval.toolName;
    }
    if (!userInput && selected.userInput) {
      userInput = { ...selected.userInput, threadId: run.threadId, turnId: run.turnId };
    }
  }
  if (userInput && approval) {
    if (keepVisibleApproval(approval, previous)) {
      userInput = null;
    } else {
      approval = null;
    }
  }
  if (userInput) {
    phase = 'input';
    toolName = 'ask_user';
  }
  return { phase, threadId: run.threadId, turnId: run.turnId, toolName, approval, userInput };
}

export function parallelLocalReads(
  calls: LocalToolCall[],
  approval: LocalToolApprovalPolicy,
): LocalToolCall[] {
  try {
    return calls.length > 1 &&
      calls.every(
        (call) =>
          PARALLEL_READ_TOOLS.has(call.function.name) &&
          !approval(call.function.name, JSON.parse(call.function.arguments)),
      ) &&
      new Set(calls.map((call) => `${call.function.name} ${call.function.arguments}`)).size ===
        calls.length
      ? calls
      : [];
  } catch {
    return [];
  }
}

export const TASK_TOOL = toolDefinition(
  'task',
  'Delegate independent bounded work to at most 3 children. explore is read-only; general makes explicitly requested edits. Children see only your prompt, not this conversation, so give complete scope and expected evidence. Results include status, summary and child_id; pass child_id with the same agent to continue one. Check child evidence before claiming success.',
  {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['explore', 'general'] },
          prompt: { type: 'string' },
          child_id: { type: 'string' },
        },
        required: ['agent', 'prompt'],
        additionalProperties: false,
      },
    },
  },
  ['tasks'],
  { kind: 'think', approval: null },
);

export const READ_CHILD_TOOL = toolDefinition(
  'read_child',
  "Read a task child's saved history by child_id in character pages; follow nextOffset.",
  { child_id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
  ['child_id'],
  { kind: 'read', approval: null },
);

export function readChild(thread: LocalThread, input: unknown): object {
  const args = argumentsRecord(input, ['child_id', 'offset', 'limit']);
  const id = text(args, 'child_id', 36);
  const child = childEntries(thread).find(
    (entry) => entry.id === id && entry.workspaceId === thread.workspaceId,
  );
  if (!child) {
    throw new Error('This child ID is unavailable in this conversation or workspace.');
  }
  const history = JSON.stringify(child.messages);
  const offset = integer(args, 'offset', 0, 0, history.length);
  const limit = integer(args, 'limit', 3072, 1, 8192);
  const end = Math.min(history.length, offset + limit);
  return {
    ...childResult(child),
    content: history.slice(offset, end),
    nextOffset: end < history.length ? end : null,
    totalCharacters: history.length,
  };
}

export interface LocalDelegationRequest {
  agent: LocalChild['agent'];
  prompt: string;
  childId?: string;
}

export function delegationRequests(input: unknown): LocalDelegationRequest[] {
  const args = argumentsRecord(input, ['tasks']);
  const tasks = args['tasks'];
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > LOCAL_FANOUT) {
    throw new Error(`task requires 1-${String(LOCAL_FANOUT)} independent tasks.`);
  }
  const requests = tasks.map((task): LocalDelegationRequest => {
    const item = argumentsRecord(task, ['agent', 'prompt', 'child_id']);
    const agent = item['agent'];
    if (agent !== 'explore' && agent !== 'general') {
      throw new Error('Choose the built-in explore or general agent.');
    }
    return {
      agent,
      prompt: text(item, 'prompt', 4096),
      ...(item['child_id'] === undefined ? {} : { childId: text(item, 'child_id', 36) }),
    };
  });
  const ids = requests.flatMap((request) => (request.childId ? [request.childId] : []));
  if (new Set(ids).size !== ids.length) {
    throw new Error('A child may only run once in a batch.');
  }
  return requests;
}

export function childEntries(thread: LocalThread): LocalChild[] {
  return thread.messages.flatMap((message) => message.children ?? []);
}

export function childResult(child: LocalChild): object {
  const answer =
    child.messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '';
  return {
    child_id: child.id,
    agent: child.agent,
    status: child.status,
    summary: answer.slice(0, CHILD_RESULT_CHARS),
    truncated: answer.length > CHILD_RESULT_CHARS,
    error: child.lastError,
  };
}

export function newLocalChild(
  agent: LocalChild['agent'],
  workspaceId: string,
  modelId: string,
): LocalChild {
  return {
    id: randomUUID().toLowerCase(),
    agent,
    workspaceId,
    modelId,
    status: 'running',
    messages: [],
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

/** A child sees exactly its own history; all writes remain inside the owning parent document. */
export function childThreadPort(
  threads: LocalThreadPort,
  parentId: string,
  childId: string,
  workspaceId: string,
  modelId: string,
): LocalThreadPort {
  const get = (id: string): LocalThread => {
    const parent = threads.get(parentId);
    const child = childEntries(parent).find((entry) => entry.id === id && id === childId);
    if (!child || child.workspaceId !== workspaceId || child.modelId !== modelId) {
      throw new Error('This child is unavailable in this conversation.');
    }

    return {
      ...parent,
      ...child,
      parentThreadId: parentId,
      contextSummary: child.contextSummary,
      tasks: child.tasks,
      workspaceId,
      modelId,
      activeTurnId: child.status === 'running' ? child.id : null,
    };
  };
  return {
    artifacts: threads.artifacts,
    flush: () => threads.flush(),
    get,
    save: async (id) => {
      get(id);
      await threads.save(parentId);
    },
    change: (id, update) => {
      const next = update(get(id));
      threads.change(parentId, (parent) => ({
        ...parent,
        messages: parent.messages.map((message): LocalMessage => ({
          ...message,
          ...(message.children
            ? {
                children: message.children.map((child) =>
                  child.id !== childId
                    ? child
                    : {
                        ...child,
                        status: next.status,
                        updatedAt: next.updatedAt,
                        lastError: next.lastError,
                        messages: next.messages,
                        contextSummary: next.contextSummary,
                        tasks: next.tasks,
                      },
                ),
              }
            : {}),
        })),
      }));
      return next;
    },
  };
}

export async function delegateLocalChildren(
  threads: LocalThreadPort,
  scope: LocalAgentRun,
  messageId: string,
  requests: LocalDelegationRequest[],
  execute: (child: LocalChild, prompt: string, port: LocalThreadPort) => Promise<LocalThread>,
): Promise<{ children: object[] }> {
  if (scope.childAdmissions + requests.length > 6) {
    throw new Error('At most 6 child admissions are allowed per parent turn.');
  }
  const existing = childEntries(threads.get(scope.threadId));
  if (existing.length + requests.filter((request) => !request.childId).length > 24) {
    throw new Error('This conversation has reached its 24-child history limit.');
  }
  const children = requests.map((request) => {
    if (!request.childId) {
      return newLocalChild(request.agent, scope.workspaceId, scope.modelId);
    }
    const child = existing.find((entry) => entry.id === request.childId);
    if (
      !child ||
      child.agent !== request.agent ||
      child.status === 'running' ||
      child.workspaceId !== scope.workspaceId ||
      child.modelId !== scope.modelId
    ) {
      throw new Error(
        'This child ID is unavailable in this conversation or has a different agent.',
      );
    }
    if (child.messages.length >= 128) {
      throw new Error('This child history is full; start a fresh child.');
    }
    return child;
  });
  scope.childAdmissions += children.length;
  threads.change(scope.threadId, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) =>
      message.id !== messageId
        ? message
        : {
            ...message,
            children: children.filter((child) => !existing.includes(child)),
          },
    ),
  }));
  await threads.save(scope.threadId);
  if (scope.controller.signal.aborted) {
    throw new Error('Child work stopped before execution.');
  }
  const results = await Promise.allSettled(
    children.map((child, index) => {
      const request = requests[index];
      if (!request) {
        throw new Error('The child request is unavailable.');
      }
      return execute(
        child,
        request.prompt,
        childThreadPort(threads, scope.threadId, child.id, scope.workspaceId, scope.modelId),
      );
    }),
  );
  return {
    children: children.map((child, index) => {
      let current = childEntries(threads.get(scope.threadId)).find(
        (entry) => entry.id === child.id,
      );
      if (!current) {
        throw new Error('The admitted child is unavailable.');
      }
      const result = results[index];
      if (result?.status === 'rejected' && current.status === 'running') {
        current = {
          ...current,
          status: 'failed',
          lastError: result.reason instanceof Error ? result.reason.message : 'Child failed.',
        };
        const failed = current;
        const port = childThreadPort(
          threads,
          scope.threadId,
          child.id,
          scope.workspaceId,
          scope.modelId,
        );
        port.change(child.id, (thread) => ({ ...thread, ...failed }));
      }
      return {
        ...childResult(current),
        ...(result?.status === 'rejected' && !current.lastError
          ? {
              error: result.reason instanceof Error ? result.reason.message : 'Child failed.',
            }
          : {}),
      };
    }),
  };
}
