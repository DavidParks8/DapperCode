import {
  extractLastError,
  hasActiveAcpRun,
  mapRawStatus,
} from '@bridge/mapping/chatMappingStatusAndErrorProjection';
import {
  readAgentId,
  readThreadItemText,
  readThreadSourceMetadata,
} from '@bridge/mapping/chatMappingChatProjection';
import {
  readCoercedFiniteNumber,
  readNonNegativeIntegerLike,
  readString,
  readTrimmedStringArray,
  toRecord,
} from '@shared/runtimeValidation';
import type { ChatSummary, MessageTokenUsage, SessionTokenTotals } from '@bridge/types/types';
import {
  type RawAcpSnapshot,
  type RawSnapshotCollectionMetadata,
  type RawThread,
  type RawThreadItem,
  type RawTurn,
  toPreview,
  unixSecondsToIso,
} from '@bridge/mapping/chatMappingRawTypesAndReaders';
import { parseAgentMessageMeta } from '@bridge/messages';

function parseSnapshotMessages(snapshot: Record<string, unknown>): RawAcpSnapshot['messages'] {
  return (Array.isArray(snapshot['messages']) ? snapshot['messages'] : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: readString(entry['id']) ?? '',
      role: readString(entry['role']) ?? '',
      parts: Array.isArray(entry['parts']) ? entry['parts'] : [],
      truncated: entry['truncated'] === true,
      usage: parseSnapshotMessageUsage(entry['usage']),
      agentMessage: parseAgentMessageMeta(entry['agentMessage']),
    }))
    .filter((entry) => entry.id && entry.role);
}

function parseSnapshotMessageUsage(value: unknown): MessageTokenUsage | null {
  const usage = toRecord(value);
  if (!usage) {
    return null;
  }
  const inputTokens = readFirstNonNegativeInteger([usage['inputTokens'], usage['input_tokens']]);
  const outputTokens = readFirstNonNegativeInteger([usage['outputTokens'], usage['output_tokens']]);
  const totalTokens = readFirstNonNegativeInteger([usage['totalTokens'], usage['total_tokens']]);
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: readFirstNonNegativeInteger([
      usage['reasoningTokens'],
      usage['reasoning_tokens'],
    ]),
    cachedReadTokens: readFirstNonNegativeInteger([
      usage['cachedReadTokens'],
      usage['cached_read_tokens'],
    ]),
    cachedWriteTokens: readFirstNonNegativeInteger([
      usage['cachedWriteTokens'],
      usage['cached_write_tokens'],
    ]),
    totalTokens,
    model: readString(usage['model'])?.trim() || null,
  };
}

function parseSnapshotTools(snapshot: Record<string, unknown>): RawAcpSnapshot['tools'] {
  return (Array.isArray(snapshot['tools']) ? snapshot['tools'] : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: readString(entry['id']) ?? '',
      generation: readCoercedFiniteNumber(entry['generation']),
      kind: readString(entry['kind']) ?? '',
      status: readString(entry['status']) ?? '',
      title: readString(entry['title']) ?? '',
      startedAtMs: readSnapshotTimestamp(entry['startedAtMs']),
      completedAtMs: readSnapshotTimestamp(entry['completedAtMs']),
      content: readString(entry['content']) ?? '',
      structuredContent: Array.isArray(entry['structuredContent'])
        ? entry['structuredContent']
        : [],
      locations: Array.isArray(entry['locations']) ? entry['locations'] : [],
      truncated: entry['truncated'] === true,
      subagent: entry['subagent'] === true,
    }))
    .filter((entry) => entry.id);
}

function readSnapshotTimestamp(value: unknown): number | null {
  const timestamp = readNonNegativeIntegerLike(value);
  return timestamp !== null && Number(value) >= 0 ? timestamp : null;
}

function parseSnapshotTimeline(
  snapshot: Record<string, unknown>,
): NonNullable<RawAcpSnapshot['timeline']> {
  return (Array.isArray(snapshot['timeline']) ? snapshot['timeline'] : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      sequence: readCoercedFiniteNumber(entry['sequence']) ?? -1,
      kind: readString(entry['kind']),
      canonicalId: readString(entry['canonicalId']) ?? '',
    }))
    .filter(
      (entry): entry is NonNullable<RawAcpSnapshot['timeline']>[number] =>
        entry.sequence >= 0 &&
        (entry.kind === 'message' || entry.kind === 'reasoning' || entry.kind === 'tool') &&
        Boolean(entry.canonicalId),
    );
}

function parseSnapshotPlan(snapshot: Record<string, unknown>): RawAcpSnapshot['plan'] {
  return (Array.isArray(snapshot['plan']) ? snapshot['plan'] : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      content: readString(entry['content']) ?? '',
      priority: readString(entry['priority']) ?? '',
      status: readString(entry['status']) ?? '',
    }))
    .filter((entry) => entry.content);
}

function parseSnapshotConfig(snapshot: Record<string, unknown>): RawAcpSnapshot['config'] {
  return (Array.isArray(snapshot['config']) ? snapshot['config'] : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: readString(entry['id']) ?? '',
      value: readString(entry['value']) ?? '',
      name: readString(entry['name']) ?? undefined,
      description: readString(entry['description']) ?? undefined,
      category: readString(entry['category']) ?? undefined,
      options: (Array.isArray(entry['options']) ? entry['options'] : [])
        .map(toRecord)
        .filter((option): option is Record<string, unknown> => option !== null)
        .map((option) => ({
          value: readString(option['value']) ?? '',
          name: readString(option['name']) ?? '',
          description: readString(option['description']) ?? undefined,
        }))
        .filter((option) => option.value && option.name),
    }))
    .filter((entry) => entry.id);
}

function parseSnapshotCommands(snapshot: Record<string, unknown>): RawAcpSnapshot['commands'] {
  return (Array.isArray(snapshot['commands']) ? snapshot['commands'] : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      name: readString(entry['name']) ?? '',
      description: readString(entry['description']) ?? '',
    }))
    .filter((entry) => entry.name);
}

function parseSnapshotUsage(usageValue: unknown): RawAcpSnapshot['usage'] {
  const usage = toRecord(usageValue) ?? {};
  return {
    used: readCoercedFiniteNumber(usage['used']),
    size: readCoercedFiniteNumber(usage['size']),
    cost: readString(usage['cost']),
  };
}

function readFirstNonNegativeInteger(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = readNonNegativeIntegerLike(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseSnapshotTokenTotals(value: unknown): SessionTokenTotals | null {
  const totals = toRecord(value);
  if (!totals) {
    return null;
  }
  const turns = readNonNegativeIntegerLike(totals['turns']);
  const inputTokens = readFirstNonNegativeInteger([totals['inputTokens'], totals['input_tokens']]);
  const outputTokens = readFirstNonNegativeInteger([
    totals['outputTokens'],
    totals['output_tokens'],
  ]);
  const totalTokens = readFirstNonNegativeInteger([totals['totalTokens'], totals['total_tokens']]);
  if (turns === null || inputTokens === null || outputTokens === null || totalTokens === null) {
    return null;
  }

  return {
    turns,
    inputTokens,
    outputTokens,
    reasoningTokens: readFirstNonNegativeInteger([
      totals['reasoningTokens'],
      totals['reasoning_tokens'],
    ]),
    cachedReadTokens: readFirstNonNegativeInteger([
      totals['cachedReadTokens'],
      totals['cached_read_tokens'],
    ]),
    cachedWriteTokens: readFirstNonNegativeInteger([
      totals['cachedWriteTokens'],
      totals['cached_write_tokens'],
    ]),
    totalTokens,
  };
}

function readSnapshotCollectionMetadata(value: unknown): RawSnapshotCollectionMetadata | undefined {
  const collection = toRecord(value);
  const revision = readCoercedFiniteNumber(collection?.['revision']);
  if (!collection || revision === null) {
    return undefined;
  }
  return {
    truncated: collection['truncated'] === true,
    omittedCount: readCoercedFiniteNumber(collection['omittedCount']) ?? 0,
    oldestAvailableSequence: readCoercedFiniteNumber(collection['oldestAvailableSequence']),
    newestSequence: readCoercedFiniteNumber(collection['newestSequence']),
    beforeCursor: readString(collection['beforeCursor']),
    revision,
  };
}

function parseSnapshotContinuation(value: unknown): RawAcpSnapshot['continuation'] {
  const continuationRecord = toRecord(value);
  const continuationRevision = readCoercedFiniteNumber(continuationRecord?.['revision']);
  if (!continuationRecord || continuationRevision === null) {
    return undefined;
  }
  return {
    revision: continuationRevision,
    unavailableCount: readCoercedFiniteNumber(continuationRecord['unavailableCount']) ?? 0,
    earliestAvailableSequence: readCoercedFiniteNumber(
      continuationRecord['earliestAvailableSequence'],
    ),
    latestAvailableSequence: readCoercedFiniteNumber(continuationRecord['latestAvailableSequence']),
    maxPageSize: readCoercedFiniteNumber(continuationRecord['maxPageSize']) ?? 0,
    maxHistoryEntries: readCoercedFiniteNumber(continuationRecord['maxHistoryEntries']) ?? 0,
    maxHistoryBytes: readCoercedFiniteNumber(continuationRecord['maxHistoryBytes']) ?? 0,
  };
}

function parseSnapshotSessionInfo(session: Record<string, unknown>): RawAcpSnapshot['session'] {
  return {
    agentId: readString(session['agentId']) ?? '',
    threadId: readString(session['threadId']) ?? '',
    title: readString(session['title']),
    updatedAt: readString(session['updatedAt']),
    historyReconstruction: session['historyReconstruction'] === true,
  };
}

function parseSnapshotActiveInfo(active: Record<string, unknown>): RawAcpSnapshot['active'] {
  return {
    runId: readString(active['runId']),
    sourceTurnId: readString(active['sourceTurnId']),
    generation: readCoercedFiniteNumber(active['generation']),
    toolIds: readTrimmedStringArray(active['toolIds']),
  };
}

export function toRawAcpSnapshot(value: unknown): RawAcpSnapshot | undefined {
  const snapshot = toRecord(value);
  const session = toRecord(snapshot?.['session']);
  const active = toRecord(snapshot?.['active']);
  const version = readCoercedFiniteNumber(snapshot?.['version']);
  if (!snapshot || version !== 2 || !session || !active) {
    return undefined;
  }
  const timeline = parseSnapshotTimeline(snapshot);
  return {
    version,
    timeline: timeline.length > 0 ? timeline : undefined,
    messages: parseSnapshotMessages(snapshot),
    tools: parseSnapshotTools(snapshot),
    messageCollection: readSnapshotCollectionMetadata(snapshot['messageCollection']),
    reasoningCollection: readSnapshotCollectionMetadata(snapshot['reasoningCollection']),
    toolCollection: readSnapshotCollectionMetadata(snapshot['toolCollection']),
    continuation: parseSnapshotContinuation(snapshot['continuation']),
    plan: parseSnapshotPlan(snapshot),
    usage: parseSnapshotUsage(snapshot['usage']),
    tokenTotals: parseSnapshotTokenTotals(snapshot['tokenTotals'] ?? snapshot['token_totals']),
    mode: readString(snapshot['mode']),
    config: parseSnapshotConfig(snapshot),
    commands: parseSnapshotCommands(snapshot),
    session: parseSnapshotSessionInfo(session),
    active: parseSnapshotActiveInfo(active),
  };
}

export function toRawTurn(value: unknown): RawTurn | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const items = Array.isArray(record['items'])
    ? record['items']
        .map((item) => toRecord(item))
        .filter((item): item is RawThreadItem => item !== null)
    : undefined;
  return {
    id: readString(record['id']) ?? undefined,
    status: readString(record['status']) ?? undefined,
    error: record['error'],
    message: record['message'],
    errorMessage: record['errorMessage'],
    error_message: record['error_message'],
    detail: record['detail'],
    details: record['details'],
    reason: record['reason'],
    description: record['description'],
    stderr: record['stderr'],
    items,
  };
}

function resolveChatSummaryTimestamps(raw: RawThread): {
  createdAt: string;
  updatedAt: string;
  hasBridgeTimestamps: boolean;
} {
  const fallbackTimestampSeconds = stableThreadTimestampSeconds(raw.id ?? '');
  const hasBridgeTimestamps = raw.createdAt != null || raw.updatedAt != null;
  const createdAtSeconds = raw.createdAt ?? raw.updatedAt ?? fallbackTimestampSeconds;
  const updatedAtSeconds = raw.updatedAt ?? raw.createdAt ?? createdAtSeconds;
  return {
    createdAt: unixSecondsToIso(createdAtSeconds),
    updatedAt: unixSecondsToIso(updatedAtSeconds),
    hasBridgeTimestamps,
  };
}

function resolveChatSummaryTitle(raw: RawThread, turns: RawTurn[], previewTitle: string): string {
  const firstUserTitle = firstUserMessagePreview(turns) ?? firstSnapshotUserMessagePreview(raw);
  const rawTitle = raw.name?.trim() || null;
  const displayTitle = rawTitle || previewTitle || firstUserTitle;
  const fallbackTitle = raw.acpSnapshot?.session.threadId
    ? `Session ${shortSessionId(raw.acpSnapshot.session.threadId)}`
    : `Chat ${(raw.id ?? '').slice(0, 8)}`;
  return toPreview(displayTitle || fallbackTitle);
}

export function mapChatSummary(raw: RawThread): ChatSummary | null {
  if (!raw.id) {
    return null;
  }
  const { createdAt, updatedAt, hasBridgeTimestamps } = resolveChatSummaryTimestamps(raw);
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const sourceMetadata = readThreadSourceMetadata(raw.source);
  const lastError = extractLastError(turns);
  const previewTitle = toPreview(raw.preview || '');
  return {
    id: raw.id,
    title: resolveChatSummaryTitle(raw, turns, previewTitle),
    status: hasActiveAcpRun(raw.acpSnapshot) ? 'running' : mapRawStatus(raw.status, turns),
    createdAt,
    updatedAt,
    statusUpdatedAt: updatedAt,
    timestampsSynthesized: !hasBridgeTimestamps,
    lastMessagePreview: toPreview(raw.preview || ''),
    cwd: readString(raw.cwd) ?? undefined,
    agentId: readAgentId(raw.agentId),
    modelProvider: readString(raw.modelProvider) ?? undefined,
    agentNickname: readString(raw.agentNickname) ?? undefined,
    agentRole: readString(raw.agentRole) ?? undefined,
    sourceKind: sourceMetadata.kind,
    parentThreadId: sourceMetadata.parentThreadId,
    subAgentDepth: sourceMetadata.subAgentDepth,
    lastError: lastError ?? undefined,
  };
}

export function firstSnapshotUserMessagePreview(raw: RawThread): string | null {
  for (const message of raw.acpSnapshot?.messages ?? []) {
    if (message.role !== 'user') {
      continue;
    }
    const text = message.parts
      .map((part) =>
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
      .trim();
    const preview = toPreview(text);
    if (preview) {
      return preview;
    }
  }
  return null;
}

export function shortSessionId(value: string): string {
  const compact = value.trim().replace(/[^a-zA-Z0-9]/g, '');
  return compact.slice(-8) || 'new';
}

export function stableThreadTimestampSeconds(threadId: string): number {
  let hash = 0;
  for (const character of threadId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return 1_704_067_200 + (hash % 31_536_000);
}

export function firstUserMessagePreview(turns: RawTurn[]): string | null {
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'userMessage') {
        continue;
      }
      const text = readThreadItemText(item);
      const preview = toPreview(text);
      if (preview) {
        return preview;
      }
    }
  }
  return null;
}
