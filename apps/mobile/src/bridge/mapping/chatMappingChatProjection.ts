import { extractChatPlans } from '@bridge/mapping/chatMappingPlanExtraction';
import { getMessageText } from '@bridge/messages';
import { mapChatSummary } from '@bridge/mapping/chatMappingSnapshotAndSummaryProjection';
import { mapMessages } from '@bridge/mapping/chatMappingMessageProjection';
import { readCoercedFiniteNumber, readString, toRecord } from '@shared/runtimeValidation';
import type { AgentId, Chat } from '@bridge/types/types';
import {
  type RawAcpSnapshot,
  type RawThread,
  type RawThreadItem,
  type ThreadSourceMetadata,
  toPreview,
} from '@bridge/mapping/chatMappingRawTypesAndReaders';

export function readThreadItemText(item: RawThreadItem): string {
  const record = toRecord(item);
  const text = readString(record?.['text']);
  if (text) {
    return text;
  }
  const content = Array.isArray(record?.['content']) ? record['content'] : [];
  if (content.length === 0) {
    return '';
  }
  return content
    .map((entry) => {
      const contentEntry = toRecord(entry);
      return readString(contentEntry?.['type']) === 'text'
        ? (readString(contentEntry?.['text']) ?? '')
        : '';
    })
    .filter((entry) => entry.length > 0)
    .join('');
}

export function readAgentId(value: unknown): AgentId | null {
  const agentId = readString(value)?.trim();
  return agentId ? agentId : null;
}

export function readThreadSourceMetadata(source: unknown): ThreadSourceMetadata {
  const sourceRecord = toRecord(source);
  if (!sourceRecord) {
    return {};
  }
  // Current app-server shape: { subAgent: ... } tagged union.
  const subAgentValue = sourceRecord['subAgent'] ?? sourceRecord['subagent'];
  if (subAgentValue !== undefined) {
    return readSubAgentSourceMetadata(subAgentValue);
  }
  return {};
}

function readSubAgentSourceMetadata(subAgent: unknown): ThreadSourceMetadata {
  if (typeof subAgent === 'string') {
    return { kind: subAgentKind(subAgent) };
  }
  const subAgentRecord = toRecord(subAgent);
  if (!subAgentRecord) {
    return { kind: 'subAgent' };
  }
  const threadSpawn = toRecord(subAgentRecord['thread_spawn']);
  if (threadSpawn) {
    return withSourceFields('subAgentThreadSpawn', threadSpawn);
  }
  return readString(subAgentRecord['other'])
    ? { kind: 'subAgentOther' }
    : withSourceFields('subAgent', subAgentRecord);
}

function subAgentKind(subAgent: string): string {
  if (subAgent === 'review') {
    return 'subAgentReview';
  }
  if (subAgent === 'compact') {
    return 'subAgentCompact';
  }
  return subAgent === 'memory_consolidation' ? 'subAgentOther' : 'subAgent';
}

function withSourceFields(kind: string, source: Record<string, unknown>): ThreadSourceMetadata {
  return {
    kind,
    parentThreadId:
      readString(source['parentThreadId']) ?? readString(source['parent_thread_id']) ?? undefined,
    subAgentDepth:
      readCoercedFiniteNumber(source['depth']) ??
      readCoercedFiniteNumber(source['agentDepth']) ??
      readCoercedFiniteNumber(source['agent_depth']) ??
      undefined,
  };
}

export function mapChat(raw: RawThread): Chat {
  const summary = mapChatSummary(raw);
  if (!summary) {
    throw new Error('chat id missing in app-server response');
  }
  const messages = mapMessages(raw, summary.createdAt);
  const plans = extractChatPlans(raw);
  const lastMessage = messages.at(-1);
  const lastPreview = lastMessage
    ? toPreview(getMessageText(lastMessage))
    : summary.lastMessagePreview;
  return {
    ...summary,
    lastMessagePreview: lastPreview,
    messages,
    acpSnapshot: raw.acpSnapshot,
    latestPlan: plans.latestPlan,
    latestTurnPlan: plans.latestTurnPlan,
    latestTurnStatus: plans.latestTurnStatus,
    activeTurnId: plans.activeTurnId,
    ...mapAcpSnapshotFields(raw.acpSnapshot),
  };
}

function mapAcpSnapshotFields(snapshot: RawThread['acpSnapshot']) {
  if (!snapshot) {
    return {
      acpUsage: null,
      tokenTotals: null,
      acpMode: null,
      acpConfig: [],
      acpCommands: [],
      acpActive: null,
    };
  }
  return {
    acpUsage: {
      used: snapshot.usage.used ?? null,
      size: snapshot.usage.size ?? null,
      cost: snapshot.usage.cost ?? null,
    },
    tokenTotals: snapshot.tokenTotals ?? null,
    acpMode: snapshot.mode ?? null,
    acpConfig: snapshot.config ?? [],
    acpCommands: snapshot.commands ?? [],
    acpActive: {
      runId: snapshot.active.runId ?? null,
      sourceTurnId: snapshot.active.sourceTurnId ?? null,
      generation: snapshot.active.generation ?? null,
      toolIds: snapshot.active.toolIds,
    },
  };
}

export function applySnapshotToChat(chat: Chat, acpSnapshot: RawAcpSnapshot): Chat {
  const mapped = mapChat({
    id: chat.id,
    agentId: chat.agentId,
    name: chat.title,
    preview: chat.lastMessagePreview,
    modelProvider: chat.modelProvider,
    createdAt: Date.parse(chat.createdAt) / 1000,
    updatedAt: Date.parse(chat.updatedAt) / 1000,
    status: { type: chat.status },
    cwd: chat.cwd,
    acpSnapshot,
  });
  return {
    ...chat,
    ...mapped,
    title: chat.title,
    status: chat.status,
    statusUpdatedAt: chat.statusUpdatedAt,
    sourceKind: chat.sourceKind,
    parentThreadId: chat.parentThreadId,
    subAgentDepth: chat.subAgentDepth,
    acpSnapshot,
  };
}
