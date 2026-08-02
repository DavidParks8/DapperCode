import {
  COMPACTION_ACTIVITY_TYPE,
  createActivityMessage,
  SUBAGENT_ACTIVITY_TYPE,
} from './messages';
import {
  generateLocalId,
  isChatMessagePart,
  isFailedSubAgentState,
  isTerminalSubAgentState,
  parseSnapshotTaskSubagent,
  resolveSubAgentState,
  stringifyStructuredMessageContent,
} from './chatMappingPlanParsing';
import { normalizeType, toSubAgentMeta } from './chatMappingToolArgumentParsers';
import { renderAgUiCustomContent } from './agUi';
import { structuredTextRemainder } from './agUiContent';
import { toToolKind, toToolStatus } from './toolMeta';
import { toToolLikeMessage } from './chatMappingToolMessageProjection';
import { readString, toRecord } from '../runtimeValidation';
import { type ChatMessage } from './types';
import { type RawAcpSnapshot, type RawThread } from './chatMappingRawTypesAndReaders';

type SnapshotMessage = RawAcpSnapshot['messages'][number];
type SnapshotTool = RawAcpSnapshot['tools'][number];
type SnapshotTimelineEntry = NonNullable<RawAcpSnapshot['timeline']>[number];

interface SnapshotMappingContext {
  raw: RawThread;
  acpSnapshot: RawAcpSnapshot;
  messagesById: Map<string, SnapshotMessage>;
  toolsById: Map<string, SnapshotTool>;
  baseTs: number;
}

function buildSnapshotSubagentActivity(
  tool: SnapshotTool,
  raw: RawThread,
  taskSubagent: ReturnType<typeof parseSnapshotTaskSubagent>,
  createdAt: string,
): ChatMessage {
  const state = resolveSubAgentState(tool.status, taskSubagent?.state);
  const text = [
    isFailedSubAgentState(state)
      ? '• Sub-agent failed'
      : isTerminalSubAgentState(state)
        ? '• Sub-agent completed'
        : '• Sub-agent working',
    `  Status: ${state}`,
    taskSubagent?.result ? `  Latest: ${taskSubagent.result}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return createActivityMessage(
    `subagent:${tool.id}`,
    SUBAGENT_ACTIVITY_TYPE,
    {
      text,
      subAgent: {
        toolCallId: tool.id,
        tool: 'spawnAgent',
        senderThreadId: raw.id,
        receiverThreadIds: taskSubagent?.threadId ? [taskSubagent.threadId] : [],
        agentStatus: state,
      },
    },
    createdAt,
  );
}

function buildSnapshotToolMessage(tool: SnapshotTool, createdAt: string): ChatMessage {
  const hasStructured = tool.structuredContent.length > 0 || tool.locations.length > 0;
  const structured = hasStructured
    ? renderAgUiCustomContent({
        content: tool.structuredContent,
        locations: tool.locations,
      })
    : '';
  // `tool.content` is the plain-text rendering of the same payload, so keep
  // only what it does not already cover instead of printing it twice.
  const structuredExtras = structuredTextRemainder(tool.content, structured);
  const details = [tool.title || tool.kind, tool.content, structuredExtras]
    .filter(Boolean)
    .join('\n');
  return {
    id: `tool:${tool.id}`,
    role: 'tool' as const,
    toolCallId: tool.id,
    content: `${details || tool.id}${tool.truncated ? '\n[tool content truncated]' : ''}`,
    createdAt,
    toolMeta: {
      toolCallId: tool.id,
      kind: toToolKind(tool.kind),
      status: toToolStatus(tool.status),
      title: tool.title || toToolKind(tool.kind),
      content: tool.structuredContent,
      locations: tool.locations,
      truncated: tool.truncated,
    },
  };
}

function mapSnapshotToolEntry(
  entry: SnapshotTimelineEntry,
  index: number,
  context: SnapshotMappingContext,
): ChatMessage[] {
  const tool = context.toolsById.get(entry.canonicalId);
  if (!tool) {
    return [];
  }
  const taskSubagent = parseSnapshotTaskSubagent(tool.content, context.acpSnapshot.session.agentId);
  const createdAt = new Date(context.baseTs + index * 1000).toISOString();
  if (taskSubagent || isSnapshotSubagentTool(tool)) {
    return [buildSnapshotSubagentActivity(tool, context.raw, taskSubagent, createdAt)];
  }
  return [buildSnapshotToolMessage(tool, createdAt)];
}

function mapSnapshotMessageEntry(
  entry: SnapshotTimelineEntry,
  index: number,
  context: SnapshotMappingContext,
): ChatMessage[] {
  const message = context.messagesById.get(entry.canonicalId);
  if (!message) {
    return [];
  }
  const parts = message.parts.filter(isChatMessagePart);
  const content = parts
    .map((part) => renderAgUiCustomContent(part))
    .filter(Boolean)
    .join('\n');
  if (!content) {
    return [];
  }
  const common = {
    id: message.id,
    content: `${content}${message.truncated ? '\n[message content truncated]' : ''}`,
    parts,
    createdAt: new Date(context.baseTs + index * 1000).toISOString(),
  };
  if (message.role === 'agent') {
    return [{ ...common, role: 'assistant' as const }];
  }
  if (message.role === 'user') {
    return [{ ...common, role: 'user' as const }];
  }
  return [{ ...common, role: 'reasoning' as const }];
}

function mapSnapshotTimelineEntry(
  entry: SnapshotTimelineEntry,
  index: number,
  context: SnapshotMappingContext,
): ChatMessage[] {
  return entry.kind === 'tool'
    ? mapSnapshotToolEntry(entry, index, context)
    : mapSnapshotMessageEntry(entry, index, context);
}

function buildSnapshotTimeline(acpSnapshot: RawAcpSnapshot): SnapshotTimelineEntry[] {
  return (
    acpSnapshot.timeline ?? [
      ...acpSnapshot.messages.map((message, sequence) => ({
        sequence,
        kind: message.role === 'thought' ? ('reasoning' as const) : ('message' as const),
        canonicalId: message.id,
      })),
      ...acpSnapshot.tools.map((tool, index) => ({
        sequence: acpSnapshot.messages.length + index,
        kind: 'tool' as const,
        canonicalId: tool.id,
      })),
    ]
  );
}

function buildSnapshotTruncationNotices(acpSnapshot: RawAcpSnapshot): string[] {
  const collections = [
    ['messages', acpSnapshot.messageCollection],
    ['reasoning', acpSnapshot.reasoningCollection],
    ['tools', acpSnapshot.toolCollection],
  ] as const;
  const truncated = collections
    .filter(([, collection]) => collection?.truncated)
    .map(([name, collection]) => `${name}: ${String(collection?.omittedCount ?? 0)} omitted`);
  if ((acpSnapshot.continuation?.unavailableCount ?? 0) > 0) {
    truncated.push(
      `older history unavailable: ${String(acpSnapshot.continuation?.unavailableCount)}`,
    );
  }
  return truncated;
}

function mapMessagesFromAcpSnapshot(raw: RawThread, fallbackCreatedAt: string): ChatMessage[] {
  const acpSnapshot = raw.acpSnapshot;
  if (!acpSnapshot) {
    return [];
  }
  const baseTs = new Date(fallbackCreatedAt).getTime();
  const context: SnapshotMappingContext = {
    raw,
    acpSnapshot,
    messagesById: new Map(acpSnapshot.messages.map((message) => [message.id, message])),
    toolsById: new Map(acpSnapshot.tools.map((tool) => [tool.id, tool])),
    baseTs,
  };
  const timeline = buildSnapshotTimeline(acpSnapshot);
  const mapped = [...timeline]
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap<ChatMessage>((entry, index) => mapSnapshotTimelineEntry(entry, index, context));
  const truncated = buildSnapshotTruncationNotices(acpSnapshot);
  if (truncated.length > 0) {
    mapped.unshift({
      id: `${raw.id ?? 'thread'}::snapshot-truncated`,
      role: 'system',
      content: `Snapshot truncated (${truncated.join(', ')})`,
      createdAt: new Date(baseTs - 1).toISOString(),
    });
  }
  return mapped;
}

function pushUserOrAgentTurnMessage(
  messages: ChatMessage[],
  itemRecord: Record<string, unknown>,
  role: 'user' | 'assistant',
  baseTs: number,
): boolean {
  const text =
    role === 'user'
      ? stringifyStructuredMessageContent(itemRecord)
      : stringifyStructuredMessageContent(itemRecord) || readString(itemRecord.text) || '';
  if (!text.trim()) {
    return false;
  }
  messages.push({
    id: readString(itemRecord.id) ?? generateLocalId(),
    role,
    content: text,
    createdAt: new Date(baseTs + messages.length * 1000).toISOString(),
  });
  return true;
}

function pushToolLikeTurnMessage(
  messages: ChatMessage[],
  itemRecord: Record<string, unknown>,
  normalizedItemType: string,
  toolLikeMessage: string,
  baseTs: number,
): void {
  const id = readString(itemRecord.id) ?? generateLocalId();
  const createdAt = new Date(baseTs + messages.length * 1000).toISOString();
  if (normalizedItemType === 'reasoning') {
    messages.push({ id, role: 'reasoning', content: toolLikeMessage, createdAt });
    return;
  }
  if (normalizedItemType === 'collabtoolcall') {
    messages.push(
      createActivityMessage(
        id,
        SUBAGENT_ACTIVITY_TYPE,
        { text: toolLikeMessage, subAgent: toSubAgentMeta(itemRecord) },
        createdAt,
      ),
    );
    return;
  }
  if (normalizedItemType === 'contextcompaction') {
    messages.push(
      createActivityMessage(id, COMPACTION_ACTIVITY_TYPE, { text: toolLikeMessage }, createdAt),
    );
    return;
  }
  messages.push({
    id,
    role: 'tool',
    toolCallId: readString(itemRecord.callId) ?? readString(itemRecord.call_id) ?? id,
    content: toolLikeMessage,
    createdAt,
  });
}

function mapTurnItem(messages: ChatMessage[], item: unknown, baseTs: number): void {
  const itemRecord = toRecord(item);
  if (!itemRecord) {
    return;
  }
  const itemType = readString(itemRecord.type);
  const normalizedItemType = normalizeType(itemType ?? '');
  if (normalizedItemType === 'usermessage') {
    pushUserOrAgentTurnMessage(messages, itemRecord, 'user', baseTs);
    return;
  }
  if (normalizedItemType === 'agentmessage') {
    pushUserOrAgentTurnMessage(messages, itemRecord, 'assistant', baseTs);
    return;
  }
  const toolLikeMessage = toToolLikeMessage(itemRecord);
  if (toolLikeMessage) {
    pushToolLikeTurnMessage(messages, itemRecord, normalizedItemType, toolLikeMessage, baseTs);
  }
}

function mapMessagesFromTurns(raw: RawThread, fallbackCreatedAt: string): ChatMessage[] {
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  if (turns.length === 0) {
    return [];
  }
  const baseTs = new Date(fallbackCreatedAt).getTime();
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      mapTurnItem(messages, item, baseTs);
    }
  }
  return messages;
}

export function mapMessages(raw: RawThread, fallbackCreatedAt: string): ChatMessage[] {
  if (raw.acpSnapshot) {
    return mapMessagesFromAcpSnapshot(raw, fallbackCreatedAt);
  }
  return mapMessagesFromTurns(raw, fallbackCreatedAt);
}

export function isSnapshotSubagentTool(tool: RawAcpSnapshot['tools'][number]): boolean {
  if (tool.subagent) {
    // The bridge classifies a task tool from the first update that names it and remembers the
    // verdict. Agents rename the tool once it reports a description, so the live title alone
    // cannot be trusted while the sub-agent is still working.
    return true;
  }
  const title = tool.title.trim().toLowerCase().replace(/[-_ ]/g, '');
  return title === 'task' || title === 'spawnagent' || title === 'subagent';
}
