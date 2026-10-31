import { isRecord } from '@shared/records';
import type { LocalMessage, LocalThread, LocalToolCall } from './types';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function threadDocument(id: string): string {
  if (!UUID.test(id)) {
    throw new Error('Invalid local conversation identity.');
  }
  return `thread-${id.toLowerCase()}.json`;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Local conversation data is invalid.');
  }
  return value;
}

function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value)) {
    throw new Error('Local conversation text is invalid.');
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function toolCall(value: unknown): LocalToolCall {
  const call = record(value);
  const fn = record(call['function']);
  if (call['type'] !== 'function') {
    throw new Error('Local conversation tool-call data is invalid.');
  }
  return {
    id: text(call['id']),
    type: 'function',
    function: { name: text(fn['name']), arguments: text(fn['arguments'], true) },
  };
}

function tool(value: unknown): NonNullable<LocalMessage['tool']> {
  const item = record(value);
  const status = item['status'];
  if (
    status !== 'pending' &&
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'interrupted'
  ) {
    throw new Error('Local tool status is invalid.');
  }
  return {
    callId: text(item['callId']),
    name: text(item['name']),
    status,
    startedAt: text(item['startedAt']),
    ...(item['completedAt'] === undefined ? {} : { completedAt: text(item['completedAt']) }),
  };
}

function message(value: unknown): LocalMessage {
  const item = record(value);
  const role = item['role'];
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new Error('Local conversation message role is invalid.');
  }
  const calls = item['toolCalls'];
  if (calls !== undefined && !Array.isArray(calls)) {
    throw new Error('Local conversation tool calls are invalid.');
  }
  const parsed: LocalMessage = {
    id: text(item['id']),
    role,
    content: text(item['content'], true),
    createdAt: text(item['createdAt']),
    ...(item['reasoning'] === undefined ? {} : { reasoning: text(item['reasoning'], true) }),
    ...(Array.isArray(calls) ? { toolCalls: calls.map(toolCall) } : {}),
    ...(item['tool'] === undefined ? {} : { tool: tool(item['tool']) }),
  };
  if (role === 'tool' && !parsed.tool) {
    throw new Error('A local tool result is missing its invocation metadata.');
  }
  return parsed;
}

export function parseLocalMessage(value: unknown): LocalMessage {
  return message(value);
}

export const LOCAL_THREAD_HEADER_KEYS = [
  'title',
  'workspaceId',
  'modelId',
  'createdAt',
  'updatedAt',
  'status',
  'activeTurnId',
  'lastSubmissionId',
  'lastError',
] as const;

export type LocalThreadHeaderKey = (typeof LOCAL_THREAD_HEADER_KEYS)[number];
export type LocalThreadHeader = Pick<LocalThread, LocalThreadHeaderKey>;

function status(value: unknown): LocalThread['status'] {
  if (
    value !== 'idle' &&
    value !== 'running' &&
    value !== 'complete' &&
    value !== 'interrupted' &&
    value !== 'failed'
  ) {
    throw new Error('The local conversation status is invalid.');
  }
  return value;
}

/** Validates one conversation-level field, as stored in a base document or a journal segment. */
export function parseLocalThreadField(
  key: LocalThreadHeaderKey,
  value: unknown,
): LocalThreadHeader[LocalThreadHeaderKey] {
  switch (key) {
    case 'status':
      return status(value);
    case 'activeTurnId':
    case 'lastSubmissionId':
    case 'lastError':
      return nullableText(value);
    default:
      return text(value);
  }
}

export function parseLocalJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('The local conversation is damaged. Its file has been preserved.');
    }
    throw error;
  }
}

export interface LocalThreadBase {
  thread: LocalThread;
  /** The last journal position the base accounts for (0 for a legacy document). */
  sequence: number;
  /** Positions at or before `sequence` that were never applied and could not be set aside. */
  skipped: number[];
  /** A whole-conversation document without a journal position, from an older build. */
  legacy: boolean;
}

function journalPositions(value: unknown, sequence: number): number[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (position) =>
        typeof position === 'number' &&
        Number.isSafeInteger(position) &&
        position > 0 &&
        position <= sequence,
    )
  ) {
    throw new Error('The local conversation journal position is invalid.');
  }
  return value as number[];
}

/**
 * Reads a conversation base document: a compacted base whose `segment` records the last journal
 * position it accounts for, or a whole-thread document from an older build (no `segment`), which
 * never owns any journal segment.
 */
export function parseLocalThreadBase(raw: string, expectedId: string): LocalThreadBase {
  const item = record(parseLocalJson(raw));
  if (item['version'] !== 1 || item['id'] !== expectedId || !Array.isArray(item['messages'])) {
    throw new Error('The local conversation version or identity is invalid.');
  }
  const legacy = item['segment'] === undefined;
  const sequence = item['segment'] ?? 0;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('The local conversation journal position is invalid.');
  }
  return {
    sequence,
    skipped: journalPositions(item['skipped'], sequence),
    legacy,
    thread: {
      version: 1,
      id: expectedId,
      title: text(item['title']),
      workspaceId: text(item['workspaceId']),
      modelId: text(item['modelId']),
      createdAt: text(item['createdAt']),
      updatedAt: text(item['updatedAt']),
      status: status(item['status']),
      activeTurnId: nullableText(item['activeTurnId']),
      lastSubmissionId: nullableText(item['lastSubmissionId']),
      lastError: nullableText(item['lastError']),
      messages: item['messages'].map(message),
    },
  };
}

export function parseLocalThread(raw: string, expectedId: string): LocalThread {
  return parseLocalThreadBase(raw, expectedId).thread;
}

export function recoverLocalThread(thread: LocalThread): LocalThread {
  if (thread.status !== 'running' && thread.activeTurnId === null) {
    return thread;
  }
  const detail =
    'This local run was interrupted. A pending edit or Git operation may already have happened; inspect the workspace before retrying.';
  const results = new Set(
    thread.messages.flatMap((message) => (message.tool ? [message.tool.callId] : [])),
  );
  const missing: LocalMessage[] = thread.messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .filter((call) => !results.has(call.id))
      .map((call) => ({
        id: `recovered-${call.id}`,
        role: 'tool',
        createdAt: thread.updatedAt,
        content: JSON.stringify({ error: detail }),
        tool: {
          callId: call.id,
          name: call.function.name,
          status: 'interrupted',
          startedAt: thread.updatedAt,
        },
      })),
  );
  return {
    ...thread,
    status: 'interrupted',
    activeTurnId: null,
    lastError: detail,
    messages: [
      ...thread.messages.map((message): LocalMessage =>
        message.tool && (message.tool.status === 'pending' || message.tool.status === 'running')
          ? {
              ...message,
              content: JSON.stringify({ error: detail }),
              tool: { ...message.tool, status: 'interrupted' },
            }
          : message,
      ),
      ...missing,
    ],
  };
}
