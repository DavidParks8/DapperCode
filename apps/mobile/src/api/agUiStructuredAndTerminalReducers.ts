import {
  appendOrderedPart,
  nonEmptyString,
  renderOrderedParts,
  timestampIso,
} from './agUiReducerUtilities';
import { createActivityMessage, SUBAGENT_ACTIVITY_TYPE } from './messages';
import { renderAgUiCustomContent, structuredTextRemainder } from './agUiContent';
import { type AgUiEventEnvelope } from './agUi';
import {
  findMessageIndex,
  indexMessages,
  type AgUiThreadMessageState,
} from './agUiMessagesState';
import { type ChatMessage, type ChatMessageSubAgentMeta } from './types';
import { type ToolCall } from '@ag-ui/core';
import { upsertMessage } from './agUiMessageMutations';
import { upsertToolResult } from './agUiToolAndCustomEventReducers';
import { attachToolMeta, withToolStructured } from './toolMeta';

export function reduceStructuredMessageContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const messageId = nonEmptyString(value?.messageId) ?? `${envelope.runId}:content`;
  const role =
    value?.role === 'thought' ? 'reasoning' : value?.role === 'user' ? 'user' : 'assistant';
  const existing = findMessage(current, messageId);
  const parts = appendOrderedPart(existing?.parts ?? [], value?.content);
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
  const toolCallId = nonEmptyString(value?.toolCallId);
  if (toolCallId && current.subagentToolCallIds[toolCallId]) return current;
  const revision = nonEmptyString(value?.revision);
  const content = typeof value?.content === 'string' ? value.content : null;
  if (!toolCallId || !revision || content === null) return current;
  if (current.toolTextRevisionByCallId[toolCallId] === revision) return current;
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
  const toolCallId = nonEmptyString(value?.toolCallId) ?? 'unknown';
  if (current.subagentToolCallIds[toolCallId]) return current;
  const revision = nonEmptyString(value?.revision) ?? JSON.stringify(value);
  if (current.structuredRevisionByCallId[toolCallId] === revision) return current;
  const structured =
    Array.isArray(value?.content) &&
    value.content.length === 0 &&
    Array.isArray(value?.locations) &&
    value.locations.length === 0
      ? ''
      : renderAgUiCustomContent(value);
  const messageId = current.toolResultMessageIdByCallId[toolCallId] ?? `tool-result:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const existingText = existing?.role === 'tool' ? existing.content : '';
  const previousStructured = current.structuredTextByCallId[toolCallId] ?? '';
  const base =
    previousStructured && existingText.endsWith(previousStructured)
      ? existingText.slice(0, -previousStructured.length).trimEnd()
      : existingText;
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
    Array.isArray(value?.content) ? value.content : undefined,
    Array.isArray(value?.locations) ? value.locations : undefined,
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

export function reduceSubagentActivity(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId) ?? 'unknown';
  const receiverThreadIds = Array.isArray(value?.receiverThreadIds)
    ? value.receiverThreadIds.map(nonEmptyString).filter((id): id is string => Boolean(id))
    : [];
  if (receiverThreadIds.length === 0) return current;
  const meta: ChatMessageSubAgentMeta = {
    toolCallId,
    tool: nonEmptyString(value?.tool) ?? 'spawnAgent',
    senderThreadId: nonEmptyString(value?.senderThreadId) ?? envelope.threadId,
    receiverThreadIds: Array.from(new Set(receiverThreadIds)),
    agentStatus: nonEmptyString(value?.agentStatus) ?? undefined,
  };
  const resultPreview = nonEmptyString(value?.resultPreview);
  const text = [
    meta.agentStatus === 'completed' ? '• Spawned sub-agent' : '• Spawning sub-agent',
    `  Thread: ${receiverThreadIds[0]}`,
    meta.agentStatus ? `  Status: ${meta.agentStatus}` : null,
    resultPreview ? `  Result: ${resultPreview}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const messages = current.messages.filter(
    (message) =>
      !(
        message.id === `tool-call:${toolCallId}` ||
        message.id === `tool-result:${toolCallId}` ||
        message.id === `subagent:${toolCallId}`
      ),
  );
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

export function markTerminal(
  current: AgUiThreadMessageState,
  messageId: string,
): AgUiThreadMessageState {
  const messages = settleReasoningMessages(current.messages, new Set([messageId]));
  if (current.terminalMessageIds.includes(messageId) && messages === current.messages) return current;
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
): AgUiThreadMessageState {
  const ids = Object.entries(current.runByMessageId)
    .filter(([, messageRunId]) => messageRunId === runId)
    .map(([messageId]) => messageId);
  if (ids.length === 0) return current;
  const idSet = new Set(ids);
  return {
    ...current,
    messages: settleReasoningMessages(current.messages, idSet),
    terminalMessageIds: Array.from(new Set([...current.terminalMessageIds, ...ids])),
  };
}

function settleReasoningMessages(
  messages: ChatMessage[],
  terminalIds: ReadonlySet<string>,
): ChatMessage[] {
  let changed = false;
  const settled = messages.map((message) => {
    if (
      message.role !== 'reasoning' ||
      message.pending !== true ||
      !terminalIds.has(message.id)
    ) {
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
  if (!message || message.role !== 'assistant') return current;
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
