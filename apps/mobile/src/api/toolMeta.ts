import { nonEmptyString, record } from './agUiValueReaders';
import type { ChatMessage, ChatToolKind, ChatToolMeta, ChatToolStatus } from './types';

/** Custom AG-UI event the bridge streams whenever a tool's kind, status or title moves. */
export const TOOL_META_EVENT_NAME = 'dappercode.dev/tool-meta';

/** Activity message the bridge uses to carry the same facts inside a messages snapshot. */
export const TOOL_META_ACTIVITY_TYPE = 'dappercode.tool';

const TOOL_KINDS: ChatToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
];

const TOOL_STATUSES: ChatToolStatus[] = ['pending', 'in_progress', 'completed', 'failed'];

export function toToolKind(value: unknown): ChatToolKind {
  const normalized = nonEmptyString(value)?.toLowerCase().replace(/-/g, '_');
  return TOOL_KINDS.find((kind) => kind === normalized) ?? 'other';
}

export function toToolStatus(value: unknown): ChatToolStatus {
  const normalized = nonEmptyString(value)?.toLowerCase().replace(/-/g, '_');
  return TOOL_STATUSES.find((status) => status === normalized) ?? 'pending';
}

export function parseToolMeta(value: unknown, fallbackToolCallId?: string): ChatToolMeta | null {
  const entry = record(value);
  const toolCallId = nonEmptyString(entry?.toolCallId) ?? fallbackToolCallId;
  if (!entry || !toolCallId) return null;
  const kind = toToolKind(entry.kind);
  return {
    toolCallId,
    kind,
    status: toToolStatus(entry.status),
    title: nonEmptyString(entry.title) ?? kind,
    ...(Array.isArray(entry.content) ? { content: entry.content } : {}),
    ...(Array.isArray(entry.locations) ? { locations: entry.locations } : {}),
    ...(typeof entry.truncated === 'boolean' ? { truncated: entry.truncated } : {}),
  };
}

/**
 * Later updates only carry what moved, so structured content and locations are
 * kept from the previous revision when an update leaves them out.
 */
export function mergeToolMeta(
  previous: ChatToolMeta | undefined,
  next: ChatToolMeta,
): ChatToolMeta {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    content: next.content ?? previous.content,
    locations: next.locations ?? previous.locations,
    truncated: next.truncated ?? previous.truncated,
  };
}

/**
 * Structured content arrives on its own event, so it updates the payload of an
 * existing record without disturbing the kind, status or title it already has.
 */
export function withToolStructured(
  previous: ChatToolMeta | undefined,
  toolCallId: string,
  content: unknown[] | undefined,
  locations: unknown[] | undefined,
): ChatToolMeta {
  const base: ChatToolMeta = previous ?? {
    toolCallId,
    kind: 'other',
    status: 'pending',
    title: 'other',
  };
  return {
    ...base,
    ...(content ? { content } : {}),
    ...(locations ? { locations } : {}),
  };
}

export function messageReferencesToolCall(message: ChatMessage, toolCallId: string): boolean {
  if (message.role === 'tool') return message.toolCallId === toolCallId;
  if (message.role === 'assistant') {
    return (message.toolCalls ?? []).some((call) => call.id === toolCallId);
  }
  return false;
}

/** Stamps the metadata onto every message that speaks for the same tool call. */
export function attachToolMeta(messages: ChatMessage[], meta: ChatToolMeta): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (!messageReferencesToolCall(message, meta.toolCallId)) return message;
    const merged = mergeToolMeta(message.toolMeta, meta);
    if (message.toolMeta && shallowEqualMeta(message.toolMeta, merged)) return message;
    changed = true;
    return { ...message, toolMeta: merged } as ChatMessage;
  });
  return changed ? next : messages;
}

function shallowEqualMeta(left: ChatToolMeta, right: ChatToolMeta): boolean {
  return (
    left.kind === right.kind &&
    left.status === right.status &&
    left.title === right.title &&
    left.truncated === right.truncated &&
    left.content === right.content &&
    left.locations === right.locations
  );
}
