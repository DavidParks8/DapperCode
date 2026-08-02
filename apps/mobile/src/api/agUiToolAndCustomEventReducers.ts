import { SUBAGENT_ACTIVITY_TYPE } from './messages';
import { partsMatchMessageContent } from './agUiContent';
import {
  applyJsonPatch,
  nonEmptyString,
  record,
  timestampIso,
  upsertToolCall,
} from './agUiReducerUtilities';
import {
  attachToolMeta,
  mergeToolMeta,
  parseToolMeta,
  TOOL_META_ACTIVITY_TYPE,
  TOOL_META_EVENT_NAME,
} from './toolMeta';
import {
  findMessage,
  reduceStructuredMessageContent,
  reduceSubagentActivity,
  reduceToolContent,
  reduceToolText,
} from './agUiStructuredAndTerminalReducers';
import { startToolCall, upsertMessage } from './agUiMessageMutations';
import { type AGUIEvent, EventType, type Message, type ToolMessage } from '@ag-ui/core';
import { type AgUiEventEnvelope } from './agUi';
import {
  type AgUiThreadMessageState,
  MAX_CUSTOM_METADATA_ENTRIES,
  MAX_MESSAGES_PER_THREAD,
} from './agUiMessagesState';
import { type ChatMessage, type ChatToolMeta } from './types';

/**
 * Records a tool's kind, status and title, and stamps them onto every message
 * that speaks for the same call so the transcript can render one typed row.
 */
export function rememberToolMeta(
  current: AgUiThreadMessageState,
  meta: ChatToolMeta,
): AgUiThreadMessageState {
  if (current.subagentToolCallIds[meta.toolCallId]) return current;
  const merged = mergeToolMeta(current.toolMetaByCallId[meta.toolCallId], meta);
  return {
    ...current,
    messages: attachToolMeta(current.messages, merged),
    toolMetaByCallId: { ...current.toolMetaByCallId, [meta.toolCallId]: merged },
  };
}

export function reduceToolMeta(
  current: AgUiThreadMessageState,
  runId: string,
  value: Record<string, unknown> | null,
  timestamp?: number,
): AgUiThreadMessageState {
  const meta = parseToolMeta(value);
  if (!meta) return current;
  // A tool can be announced by its metadata before any output exists, which is
  // what puts a running row on screen the moment the agent starts working.
  const started = current.toolCallMessageIdByCallId[meta.toolCallId]
    ? current
    : startToolCall(current, runId, meta.toolCallId, meta.title, undefined, timestamp);
  return rememberToolMeta(started, meta);
}

export function appendToolArgs(
  current: AgUiThreadMessageState,
  runId: string,
  toolCallId: string,
  delta: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const messageId = current.toolCallMessageIdByCallId[toolCallId] ?? `tool-call:${toolCallId}`;
  const started = current.toolCallMessageIdByCallId[toolCallId]
    ? current
    : startToolCall(current, runId, toolCallId, 'tool', undefined, timestamp);
  const message = findMessage(started, messageId);
  if (!message || message.role !== 'assistant') return started;
  const existing = message.toolCalls?.find((call) => call.id === toolCallId);
  return upsertMessage(
    started,
    {
      ...message,
      toolCalls: upsertToolCall(
        message.toolCalls ?? [],
        toolCallId,
        existing?.function.name ?? 'tool',
        `${existing?.function.arguments ?? ''}${delta}`,
      ),
    },
    runId,
    timestamp,
  );
}

export function upsertToolResult(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  toolCallId: string,
  content: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const toolMessage: ToolMessage & { createdAt: string } = {
    id: messageId,
    role: 'tool',
    toolCallId,
    content,
    createdAt: timestampIso(timestamp),
  };
  const next = upsertMessage(current, toolMessage, runId, timestamp);
  const meta = next.toolMetaByCallId[toolCallId];
  return {
    ...next,
    // A result can land after the metadata that describes it, so the freshly
    // created message is stamped instead of waiting for the next update.
    messages: meta ? attachToolMeta(next.messages, meta) : next.messages,
    toolResultMessageIdByCallId: {
      ...next.toolResultMessageIdByCallId,
      [toolCallId]: messageId,
    },
  };
}

function collectCurrentSubagentsById(current: AgUiThreadMessageState): Map<string, ChatMessage> {
  const currentSubagents = new Map<string, ChatMessage>();
  for (const message of current.messages) {
    if (message.role !== 'activity' || message.activityType !== SUBAGENT_ACTIVITY_TYPE) {
      continue;
    }
    const toolCallId = nonEmptyString(record(message.content.subAgent)?.toolCallId);
    if (toolCallId) currentSubagents.set(toolCallId, message);
  }
  return currentSubagents;
}

function collectSnapshotSubagentIds(
  current: AgUiThreadMessageState,
  messages: Message[],
): { snapshotSubagentIds: Record<string, true>; snapshotActivityIds: Set<string> } {
  const snapshotActivityIds = new Set<string>();
  const snapshotSubagentIds = messages.reduce<Record<string, true>>(
    (ids, message) => {
      if (message.role === 'activity' && message.activityType === SUBAGENT_ACTIVITY_TYPE) {
        const content = record(message.content);
        const subAgent = record(content?.subAgent);
        const toolCallId = nonEmptyString(subAgent?.toolCallId);
        if (toolCallId) {
          ids[toolCallId] = true;
          snapshotActivityIds.add(toolCallId);
        }
      }
      return ids;
    },
    { ...current.subagentToolCallIds },
  );
  return { snapshotSubagentIds, snapshotActivityIds };
}

function restoreSuppressedSubagentCards(
  suppressedIds: string[],
  ctx: {
    currentSubagents: Map<string, ChatMessage>;
    snapshotActivityIds: Set<string>;
    restoredSubagents: Set<string>;
    terminalMessageIds: string[];
    messages: Message[];
  },
): ChatMessage[] {
  const restored: ChatMessage[] = [];
  for (const toolCallId of suppressedIds) {
    const currentSubagent = ctx.currentSubagents.get(toolCallId);
    const alreadyRestored =
      !currentSubagent ||
      ctx.snapshotActivityIds.has(toolCallId) ||
      ctx.restoredSubagents.has(toolCallId);
    if (alreadyRestored) continue;
    // A malformed bridge snapshot can forget that a live task tool was already
    // classified as a sub-agent. Keep the known card at the tool's timeline
    // position instead of letting the snapshot replace it with a generic tool.
    restored.push(
      ctx.terminalMessageIds.includes(currentSubagent.id)
        ? terminalizeSubagentCard(
            currentSubagent,
            snapshotToolFailed(ctx.messages, toolCallId) ? 'failed' : 'completed',
          )
        : currentSubagent,
    );
    ctx.restoredSubagents.add(toolCallId);
  }
  return restored;
}

function applySnapshotToolMeta(
  message: Message,
  toolMetaByCallId: Record<string, ChatToolMeta>,
  snapshotSubagentIds: Record<string, true>,
): void {
  const meta = parseToolMeta(message.content);
  if (meta && !snapshotSubagentIds[meta.toolCallId]) {
    toolMetaByCallId[meta.toolCallId] = mergeToolMeta(toolMetaByCallId[meta.toolCallId], meta);
  }
}

function buildSnapshotMessages(
  messages: Message[],
  current: AgUiThreadMessageState,
  previous: Map<string, ChatMessage>,
  currentSubagents: Map<string, ChatMessage>,
  snapshotSubagentIds: Record<string, true>,
  snapshotActivityIds: Set<string>,
  timestamp: number | undefined,
): { nextMessages: ChatMessage[]; toolMetaByCallId: Record<string, ChatToolMeta> } {
  // The snapshot describes each tool's kind and status in a companion activity
  // message. It is bookkeeping for the tool row, never a transcript entry of its
  // own, so it is folded into the metadata map and dropped here.
  const toolMetaByCallId = { ...current.toolMetaByCallId };
  const restoredSubagents = new Set<string>();
  const nextMessages: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'activity' && message.activityType === TOOL_META_ACTIVITY_TYPE) {
      applySnapshotToolMeta(message, toolMetaByCallId, snapshotSubagentIds);
      continue;
    }
    const suppressedIds = suppressedToolCallIds(message, snapshotSubagentIds);
    if (suppressedIds.length > 0) {
      nextMessages.push(
        ...restoreSuppressedSubagentCards(suppressedIds, {
          currentSubagents,
          snapshotActivityIds,
          restoredSubagents,
          terminalMessageIds: current.terminalMessageIds,
          messages,
        }),
      );
      continue;
    }
    const existing = previous.get(message.id);
    nextMessages.push({
      ...message,
      createdAt: existing?.createdAt ?? timestampIso(timestamp),
      parts: partsMatchMessageContent(existing?.parts, message.content)
        ? existing?.parts
        : undefined,
    } as ChatMessage);
  }
  return { nextMessages, toolMetaByCallId };
}

export function applyMessagesSnapshot(
  current: AgUiThreadMessageState,
  runId: string,
  messages: Message[],
  timestamp?: number,
): AgUiThreadMessageState {
  const currentSubagents = collectCurrentSubagentsById(current);
  const { snapshotSubagentIds, snapshotActivityIds } = collectSnapshotSubagentIds(
    current,
    messages,
  );
  const previous = new Map(current.messages.map((message) => [message.id, message]));
  const { nextMessages, toolMetaByCallId } = buildSnapshotMessages(
    messages,
    current,
    previous,
    currentSubagents,
    snapshotSubagentIds,
    snapshotActivityIds,
    timestamp,
  );
  const kept = Object.values(toolMetaByCallId).reduce(
    (messages, meta) => attachToolMeta(messages, meta),
    nextMessages.slice(-MAX_MESSAGES_PER_THREAD),
  );
  const keptIds = new Set(kept.map((message) => message.id));
  return {
    ...current,
    messages: kept,
    authoritativeSnapshot: true,
    runByMessageId: Object.fromEntries(nextMessages.map((message) => [message.id, runId])),
    terminalMessageIds: nextMessages.map((message) => message.id),
    subagentToolCallIds: snapshotSubagentIds,
    toolMetaByCallId,
    toolCallMessageIdByCallId: rebaseToolBookkeeping(
      current.toolCallMessageIdByCallId,
      snapshotToolCallMessageIds(kept),
      keptIds,
    ),
    toolResultMessageIdByCallId: rebaseToolBookkeeping(
      current.toolResultMessageIdByCallId,
      snapshotToolResultMessageIds(kept),
      keptIds,
    ),
  };
}

/**
 * A snapshot re-states the whole transcript under the agent's own message ids, so
 * the call-to-message bookkeeping built while streaming now points at messages
 * that are gone. Left stale, the next event for the same call resurrects the
 * pre-snapshot message at the end of the transcript and the tool renders twice.
 * Bookkeeping the snapshot does not speak for is kept only while its message
 * survives, so a call still in flight keeps updating its own row.
 */
function rebaseToolBookkeeping(
  previous: Record<string, string>,
  fromSnapshot: Map<string, string>,
  survivingMessageIds: ReadonlySet<string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [toolCallId, messageId] of Object.entries(previous)) {
    if (survivingMessageIds.has(messageId)) next[toolCallId] = messageId;
  }
  for (const [toolCallId, messageId] of fromSnapshot) {
    next[toolCallId] = messageId;
  }
  return next;
}

function snapshotToolCallMessageIds(messages: ChatMessage[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      ids.set(call.id, message.id);
    }
  }
  return ids;
}

function snapshotToolResultMessageIds(messages: ChatMessage[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool') ids.set(message.toolCallId, message.id);
  }
  return ids;
}

function snapshotToolFailed(messages: Message[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === 'tool' && message.toolCallId === toolCallId && Boolean(message.error),
  );
}

function terminalizeSubagentCard(
  message: ChatMessage,
  status: 'completed' | 'failed',
): ChatMessage {
  if (message.role !== 'activity' || message.activityType !== SUBAGENT_ACTIVITY_TYPE) {
    return message;
  }
  const meta = record(message.content.subAgent);
  const existingStatus = nonEmptyString(meta?.agentStatus);
  const effectiveStatus =
    existingStatus && isFailedSubagentStatus(existingStatus) ? existingStatus : status;
  const text = typeof message.content.text === 'string' ? message.content.text : '';
  const latest = text.split('\n').find((line) => line.trimStart().startsWith('Latest:'));
  return {
    ...message,
    content: {
      ...message.content,
      text: [
        isFailedSubagentStatus(effectiveStatus) ? '• Sub-agent failed' : '• Sub-agent completed',
        `  Status: ${effectiveStatus}`,
        latest,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
      subAgent: {
        ...meta,
        agentStatus: effectiveStatus,
      },
    },
  };
}

function isFailedSubagentStatus(status: string): boolean {
  return ['failed', 'error', 'aborted', 'cancelled', 'canceled'].includes(
    status.trim().toLowerCase(),
  );
}

function suppressedToolCallIds(message: Message, suppressed: Record<string, true>): string[] {
  if (message.role === 'tool') {
    return suppressed[message.toolCallId] ? [message.toolCallId] : [];
  }
  if (message.role === 'assistant') {
    return (message.toolCalls ?? [])
      .map((call) => call.id)
      .filter((toolCallId) => suppressed[toolCallId]);
  }
  return [];
}

export function applyActivityDelta(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  activityType: string,
  patch: unknown[],
  timestamp?: number,
): AgUiThreadMessageState {
  const existing = findMessage(current, messageId);
  const content = existing?.role === 'activity' ? existing.content : {};
  return upsertMessage(
    current,
    {
      id: messageId,
      role: 'activity',
      activityType,
      content: applyJsonPatch(content, patch) as Record<string, unknown>,
      createdAt: existing?.createdAt ?? timestampIso(timestamp),
    },
    runId,
    timestamp,
  );
}

export function reduceCustomEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  const event = envelope.event;
  if (event.type !== EventType.CUSTOM) return current;
  const value = record(event.value);
  if (event.name.endsWith('-chunk')) {
    return reduceCustomChunk(current, envelope, value);
  }
  if (event.name === 'dappercode.dev/message-content') {
    return reduceStructuredMessageContent(current, envelope, value);
  }
  if (event.name === 'dappercode.dev/tool-text') {
    return reduceToolText(current, envelope, value);
  }
  if (event.name === 'dappercode.dev/tool-content') {
    return reduceToolContent(current, envelope, value);
  }
  if (event.name === 'dappercode.dev/subagent') {
    return reduceSubagentActivity(current, envelope, value);
  }
  if (event.name === TOOL_META_EVENT_NAME) {
    return reduceToolMeta(current, envelope.runId, value, event.timestamp);
  }
  return storeCustomMetadata(current, event.name, event.value);
}

export function reduceCustomChunk(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.CUSTOM) return current;
  const chunk = readCustomChunk(envelope.event.name, value);
  if (!chunk) return current;
  const { key, count, index, data } = chunk;
  const existing = current.chunkAssemblies[key];
  const chunks =
    existing?.count === count ? { ...existing.chunks, [index]: data } : { [index]: data };
  const pending = {
    ...current,
    chunkAssemblies: { ...current.chunkAssemblies, [key]: { count, chunks } },
  };
  if (Object.keys(chunks).length !== count) return pending;
  return reduceCompletedCustomChunks(pending, envelope, envelope.event.name, key, count, chunks);
}

function readCustomChunk(
  customName: string,
  value: Record<string, unknown> | null,
): { key: string; count: number; index: number; data: string } | null {
  const canonicalId = nonEmptyString(value?.canonicalId);
  const revision = nonEmptyString(value?.revision);
  const index = typeof value?.index === 'number' ? value.index : -1;
  const count = typeof value?.count === 'number' ? value.count : 0;
  const data = typeof value?.data === 'string' ? value.data : null;
  if (!canonicalId || !revision || index < 0 || index >= count || !data) return null;
  return { key: `${customName}\0${revision}`, count, index, data };
}

function reduceCompletedCustomChunks(
  pending: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  customName: string,
  key: string,
  count: number,
  chunks: Record<number, string>,
): AgUiThreadMessageState {
  try {
    const event = {
      type: EventType.CUSTOM,
      name: customName.slice(0, -'-chunk'.length),
      value: JSON.parse(Array.from({ length: count }, (_, index) => chunks[index]).join('')),
    } as AGUIEvent;
    const completed = reduceCustomEvent(pending, { ...envelope, event });
    const chunkAssemblies = { ...completed.chunkAssemblies };
    delete chunkAssemblies[key];
    return { ...completed, chunkAssemblies };
  } catch {
    return pending;
  }
}

export function storeCustomMetadata(
  current: AgUiThreadMessageState,
  name: string,
  value: unknown,
): AgUiThreadMessageState {
  const order = current.customMetadataOrder.filter((entry) => entry !== name);
  order.push(name);
  while (order.length > MAX_CUSTOM_METADATA_ENTRIES) order.shift();
  const customMetadata = Object.fromEntries(
    order.map((entry) => [entry, entry === name ? value : current.customMetadata[entry]]),
  );
  return { ...current, customMetadata, customMetadataOrder: order };
}
