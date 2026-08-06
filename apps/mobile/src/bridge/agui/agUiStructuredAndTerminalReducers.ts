import {
  appendOrderedPart,
  nonEmptyString,
  renderOrderedParts,
  timestampIso,
} from '@bridge/agui/agUiReducerUtilities';
import { createActivityMessage, SUBAGENT_ACTIVITY_TYPE } from '@bridge/messages';
import { renderAgUiCustomContent, structuredTextRemainder } from '@bridge/agui/agUiContent';
import type { AgUiEventEnvelope } from '@bridge/agui/agUi';
import {
  findMessageIndex,
  indexMessages,
  type AgUiThreadMessageState,
} from '@bridge/agui/agUiMessagesState';
import type { ChatMessage, ChatMessageSubAgentMeta } from '@bridge/types/types';
import type { ToolCall } from '@ag-ui/core';
import { upsertMessage } from '@bridge/agui/agUiMessageMutations';
import { upsertToolResult } from '@bridge/agui/agUiToolAndCustomEventReducers';
import { attachToolMeta, withToolStructured } from '@bridge/toolMeta';

export function reduceStructuredMessageContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const messageId = nonEmptyString(value?.['messageId']) ?? `${envelope.runId}:content`;
  const role =
    value?.['role'] === 'thought' ? 'reasoning' : value?.['role'] === 'user' ? 'user' : 'assistant';
  const existing = findMessage(current, messageId);
  const parts = appendOrderedPart(existing?.parts ?? [], value?.['content']);
  const text = renderOrderedParts(parts);
  const base: ChatMessage =
    role === 'reasoning'
      ? {
          id: messageId,
          role: 'reasoning',
          content: text,
          createdAt: timestampIso(envelope.event.timestamp),
          parts,
          pending: true,
        }
      : role === 'user'
        ? {
            id: messageId,
            role: 'user',
            content: text,
            createdAt: timestampIso(envelope.event.timestamp),
            parts,
          }
        : {
            id: messageId,
            role: 'assistant',
            content: text,
            createdAt: timestampIso(envelope.event.timestamp),
            parts,
          };
  return upsertMessage(current, base, envelope.runId, envelope.event.timestamp);
}

/**
 * Appends only the part of a tool's structured rendering that its plain text does
 * not already cover. Returns what was appended so the next revision can strip it
 * again.
 */
function appendToolText(text: string, structured: string): { text: string; appended: string } {
  const appended = structuredTextRemainder(text, structured);
  return { text: [text, appended].filter(Boolean).join('\n'), appended };
}

export function reduceToolText(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.['toolCallId']);
  if (toolCallId && current.subagentToolCallIds[toolCallId]) {
    return current;
  }
  const revision = nonEmptyString(value?.['revision']);
  const content = typeof value?.['content'] === 'string' ? value['content'] : null;
  if (!toolCallId || !revision || content === null) {
    return current;
  }
  if (current.toolTextRevisionByCallId[toolCallId] === revision) {
    return current;
  }
  const messageId = current.toolResultMessageIdByCallId[toolCallId] ?? `tool-result:${toolCallId}`;
  const structured = current.structuredTextByCallId[toolCallId] ?? '';
  const joined = appendToolText(content, structured);
  const next = upsertToolResult(
    current,
    envelope.runId,
    messageId,
    toolCallId,
    joined.text,
    envelope.event.timestamp,
  );
  return {
    ...next,
    toolTextRevisionByCallId: {
      ...next.toolTextRevisionByCallId,
      [toolCallId]: revision,
    },
    structuredTextByCallId: {
      ...next.structuredTextByCallId,
      [toolCallId]: joined.appended,
    },
  };
}

export function reduceToolContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.['toolCallId']) ?? 'unknown';
  if (current.subagentToolCallIds[toolCallId]) {
    return current;
  }
  const revision = nonEmptyString(value?.['revision']) ?? JSON.stringify(value);
  if (current.structuredRevisionByCallId[toolCallId] === revision) {
    return current;
  }
  const structured = renderToolStructuredContent(value);
  const messageId = current.toolResultMessageIdByCallId[toolCallId] ?? `tool-result:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const existingText = existing?.role === 'tool' ? existing.content : '';
  const base = withoutPreviousStructuredText(
    existingText,
    current.structuredTextByCallId[toolCallId] ?? '',
  );
  const joined = appendToolText(base, structured);
  const next = upsertToolResult(
    current,
    envelope.runId,
    messageId,
    toolCallId,
    joined.text,
    envelope.event.timestamp,
  );
  // Diffs and terminal payloads are only renderable while they are still typed,
  // so the structured parts are kept next to their flattened text.
  const meta = withToolStructured(
    next.toolMetaByCallId[toolCallId],
    toolCallId,
    Array.isArray(value?.['content']) ? value['content'] : undefined,
    Array.isArray(value?.['locations']) ? value['locations'] : undefined,
  );
  return {
    ...next,
    messages: attachToolMeta(next.messages, meta),
    toolMetaByCallId: { ...next.toolMetaByCallId, [toolCallId]: meta },
    structuredRevisionByCallId: {
      ...next.structuredRevisionByCallId,
      [toolCallId]: revision,
    },
    structuredTextByCallId: {
      ...next.structuredTextByCallId,
      [toolCallId]: joined.appended,
    },
  };
}

function renderToolStructuredContent(value: Record<string, unknown> | null): string {
  const emptyContent = Array.isArray(value?.['content']) && value['content'].length === 0;
  const emptyLocations = Array.isArray(value?.['locations']) && value['locations'].length === 0;
  return emptyContent && emptyLocations ? '' : renderAgUiCustomContent(value);
}

function withoutPreviousStructuredText(text: string, previousStructured: string): string {
  return previousStructured && text.endsWith(previousStructured)
    ? text.slice(0, -previousStructured.length).trimEnd()
    : text;
}

export function reduceSubagentActivity(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.['toolCallId']) ?? 'unknown';
  const receiverThreadIds = readReceiverThreadIds(value?.['receiverThreadIds']);
  if (receiverThreadIds.length === 0) {
    return current;
  }
  const [receiverThreadId] = receiverThreadIds;
  if (!receiverThreadId) {
    return current;
  }
  const meta = createSubagentMeta(toolCallId, receiverThreadIds, value, envelope.threadId);
  const resultPreview = nonEmptyString(value?.['resultPreview']);
  const text = formatSubagentActivity(meta, receiverThreadId, resultPreview);
  const messages = withoutSubagentMessages(current.messages, toolCallId);
  return upsertMessage(
    {
      ...current,
      messages,
      messageIndexById: indexMessages(messages),
      subagentToolCallIds: {
        ...current.subagentToolCallIds,
        [toolCallId]: true,
      },
    },
    createActivityMessage(
      `subagent:${toolCallId}`,
      SUBAGENT_ACTIVITY_TYPE,
      { text, subAgent: meta },
      timestampIso(envelope.event.timestamp),
    ),
    envelope.runId,
    envelope.event.timestamp,
  );
}

function readReceiverThreadIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(nonEmptyString).filter((id): id is string => Boolean(id))
    : [];
}

function createSubagentMeta(
  toolCallId: string,
  receiverThreadIds: string[],
  value: Record<string, unknown> | null,
  threadId: string,
): ChatMessageSubAgentMeta {
  return {
    toolCallId,
    tool: nonEmptyString(value?.['tool']) ?? 'spawnAgent',
    senderThreadId: nonEmptyString(value?.['senderThreadId']) ?? threadId,
    receiverThreadIds: Array.from(new Set(receiverThreadIds)),
    agentStatus: nonEmptyString(value?.['agentStatus']) ?? undefined,
  };
}

function formatSubagentActivity(
  meta: ChatMessageSubAgentMeta,
  receiverThreadId: string,
  resultPreview: string | null,
): string {
  return [
    meta.agentStatus === 'completed' ? '• Spawned sub-agent' : '• Spawning sub-agent',
    `  Thread: ${receiverThreadId}`,
    meta.agentStatus ? `  Status: ${meta.agentStatus}` : null,
    resultPreview ? `  Result: ${resultPreview}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function withoutSubagentMessages(messages: ChatMessage[], toolCallId: string): ChatMessage[] {
  const removedIds = new Set([
    `tool-call:${toolCallId}`,
    `tool-result:${toolCallId}`,
    `subagent:${toolCallId}`,
  ]);
  return messages.filter((message) => !removedIds.has(message.id));
}

export function markTerminal(
  current: AgUiThreadMessageState,
  messageId: string,
  completedAt?: string,
): AgUiThreadMessageState {
  const idSet = new Set([messageId]);
  const messages = setMessageCompletionTime(
    settleReasoningMessages(current.messages, idSet),
    idSet,
    completedAt,
  );
  if (current.terminalMessageIds.includes(messageId) && messages === current.messages) {
    return current;
  }
  return {
    ...current,
    messages,
    terminalMessageIds: current.terminalMessageIds.includes(messageId)
      ? current.terminalMessageIds
      : [...current.terminalMessageIds, messageId],
  };
}

export function markRunTerminal(
  current: AgUiThreadMessageState,
  runId: string,
  completedAt?: string,
): AgUiThreadMessageState {
  const ids = Object.entries(current.runByMessageId)
    .filter(([, messageRunId]) => messageRunId === runId)
    .map(([messageId]) => messageId);
  if (ids.length === 0) {
    return current;
  }
  const idSet = new Set(ids);
  return {
    ...current,
    messages: setMessageCompletionTime(
      settleReasoningMessages(current.messages, idSet),
      idSet,
      completedAt,
    ),
    terminalMessageIds: Array.from(new Set([...current.terminalMessageIds, ...ids])),
  };
}

function setMessageCompletionTime(
  messages: ChatMessage[],
  messageIds: ReadonlySet<string>,
  completedAt: string | undefined,
): ChatMessage[] {
  if (!completedAt) {
    return messages;
  }
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (
      message.role !== 'assistant' ||
      !messageIds.has(message.id) ||
      (message.completedAt !== undefined && message.pending === false)
    ) {
      return message;
    }
    changed = true;
    return { ...message, completedAt: message.completedAt ?? completedAt, pending: false };
  });
  return changed ? nextMessages : messages;
}

function settleReasoningMessages(
  messages: ChatMessage[],
  terminalIds: ReadonlySet<string>,
): ChatMessage[] {
  let changed = false;
  const settled = messages.map((message) => {
    if (message.role !== 'reasoning' || message.pending !== true || !terminalIds.has(message.id)) {
      return message;
    }
    changed = true;
    return { ...message, pending: false };
  });
  return changed ? settled : messages;
}

export function updateEncryptedValue(
  current: AgUiThreadMessageState,
  entityId: string,
  encryptedValue: string,
  subtype: 'tool-call' | 'message',
): AgUiThreadMessageState {
  if (subtype === 'message') {
    const message = findMessage(current, entityId);
    return message
      ? upsertMessage(
          current,
          { ...message, encryptedValue } as ChatMessage,
          current.runByMessageId[entityId] ?? '',
          undefined,
        )
      : current;
  }
  const messageId = current.toolCallMessageIdByCallId[entityId];
  const message = messageId ? findMessage(current, messageId) : undefined;
  if (!message || message.role !== 'assistant') {
    return current;
  }
  return upsertMessage(
    current,
    {
      ...message,
      toolCalls: message.toolCalls?.map((call) =>
        call.id === entityId ? { ...call, encryptedValue } : call,
      ),
    },
    current.runByMessageId[message.id] ?? '',
    undefined,
  );
}

export function findMessage(current: AgUiThreadMessageState, id: string): ChatMessage | undefined {
  const index = findMessageIndex(current, id);
  return index >= 0 ? current.messages[index] : undefined;
}

export function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}
