import type { ChatSummary, RpcNotification } from '../api/types';
import { parseAgUiEventNotification, type AgUiEventEnvelope } from '../api/agUi';
import type { ChatWorkspaceSection } from './chatThreadTree';
import { EventType } from '@ag-ui/core';

export interface DrawerRunIndicator {
  source: 'heartbeat' | 'lifecycle';
  updatedAt: number;
}

export type DrawerRunIndicatorMap = Record<string, DrawerRunIndicator>;

const RUN_HEARTBEAT_STALE_MS = 20_000;
const RUN_LIFECYCLE_SAFETY_STALE_MS = 6 * 60 * 60 * 1000;
const RUN_INDICATOR_REFRESH_MIN_MS = 3000;
const CHAT_STATUS_EVENT_SKEW_MS = 1000;

const DRAWER_RUNNING_STATUS_HINTS = new Set([
  'running',
  'inprogress',
  'active',
  'queued',
  'pending',
]);
const DRAWER_NON_RUNNING_STATUS_HINTS = new Set([
  'complete',
  'completed',
  'success',
  'succeeded',
  'failed',
  'error',
  'interrupted',
  'aborted',
  'idle',
  'notloaded',
]);

const DRAWER_LIFECYCLE_METHODS = new Set([
  'bridge/approval.requested',
  'bridge/userInput.requested',
]);
const DRAWER_HEARTBEAT_METHODS = new Set([
  'item/started',
  'item/plan/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/mcpToolCall/progress',
  'turn/plan/updated',
  'turn/diff/updated',
]);
const DRAWER_TERMINAL_METHODS = new Set(['bridge/approval.resolved', 'bridge/userInput.resolved']);

export function countDrawerRunningChats(
  chats: ChatSummary[],
  indicators: DrawerRunIndicatorMap,
  now = Date.now(),
): number {
  return chats.reduce(
    (count, chat) => count + (isDrawerChatRunning(chat, indicators, now) ? 1 : 0),
    0,
  );
}

export function isDrawerChatRunning(
  chat: ChatSummary,
  indicators: DrawerRunIndicatorMap,
  now = Date.now(),
): boolean {
  return chat.status === 'running' || isDrawerRunIndicatorActive(indicators[chat.id], now);
}

export function isDrawerWorkspaceSectionRunning(
  section: ChatWorkspaceSection,
  indicators: DrawerRunIndicatorMap,
  now = Date.now(),
): boolean {
  return section.data.some((row) => isDrawerChatRunning(row.chat, indicators, now));
}

export function reconcileDrawerRunIndicatorsWithChats(
  previous: DrawerRunIndicatorMap,
  chats: ChatSummary[],
  now = Date.now(),
): DrawerRunIndicatorMap {
  let next = pruneStaleDrawerRunIndicators(previous, now);
  let changed = next !== previous;

  for (const chat of chats) {
    const existing = next[chat.id];
    if (chat.status === 'running') {
      const nextUpdatedAt =
        parseTimestamp(chat.statusUpdatedAt) ?? parseTimestamp(chat.updatedAt) ?? now;
      const updated = setRunningIndicator(next, chat.id, 'lifecycle', nextUpdatedAt);
      if (updated !== next) {
        next = updated;
        changed = true;
      }
      continue;
    }

    if (existing && shouldChatSnapshotClearIndicator(chat, existing)) {
      const updated = clearRunningIndicator(next, chat.id);
      if (updated !== next) {
        next = updated;
        changed = true;
      }
    }
  }

  return changed ? next : previous;
}

export function pruneStaleDrawerRunIndicators(
  previous: DrawerRunIndicatorMap,
  now = Date.now(),
): DrawerRunIndicatorMap {
  let changed = false;
  const next: DrawerRunIndicatorMap = {};

  for (const [threadId, indicator] of Object.entries(previous)) {
    if (isDrawerRunIndicatorActive(indicator, now)) {
      next[threadId] = indicator;
    } else {
      changed = true;
    }
  }

  return changed ? next : previous;
}

function updateDrawerRunIndicatorsForAgUiEvent(
  previous: DrawerRunIndicatorMap,
  agUi: AgUiEventEnvelope,
  now: number,
): DrawerRunIndicatorMap {
  if (agUi.event.type === EventType.RUN_STARTED) {
    return setRunningIndicator(previous, agUi.threadId, 'lifecycle', now);
  }
  if (agUi.event.type === EventType.TEXT_MESSAGE_CONTENT) {
    return setRunningIndicator(previous, agUi.threadId, 'heartbeat', now);
  }
  if (agUi.event.type === EventType.RUN_FINISHED || agUi.event.type === EventType.RUN_ERROR) {
    return clearRunningIndicator(previous, agUi.threadId);
  }
  return previous;
}

function updateDrawerRunIndicatorsForStatusChange(
  previous: DrawerRunIndicatorMap,
  threadId: string,
  params: Record<string, unknown> | null,
  now: number,
): DrawerRunIndicatorMap {
  const statusHint = extractDrawerStatusHint(params);
  if (statusHint && DRAWER_RUNNING_STATUS_HINTS.has(statusHint)) {
    return setRunningIndicator(previous, threadId, 'lifecycle', now);
  }
  if (statusHint && DRAWER_NON_RUNNING_STATUS_HINTS.has(statusHint)) {
    return clearRunningIndicator(previous, threadId);
  }
  return previous;
}

export function updateDrawerRunIndicatorsForEvent(
  previous: DrawerRunIndicatorMap,
  event: RpcNotification,
  now = Date.now(),
): DrawerRunIndicatorMap {
  const agUi = parseAgUiEventNotification(event);
  if (agUi) {
    return updateDrawerRunIndicatorsForAgUiEvent(previous, agUi, now);
  }
  const params = toRecord(event.params);
  const threadId = extractDrawerNotificationThreadId(params);
  if (!threadId) {
    return previous;
  }

  if (event.method === 'thread/status/changed') {
    return updateDrawerRunIndicatorsForStatusChange(previous, threadId, params, now);
  }

  if (DRAWER_LIFECYCLE_METHODS.has(event.method)) {
    return setRunningIndicator(previous, threadId, 'lifecycle', now);
  }

  if (DRAWER_TERMINAL_METHODS.has(event.method)) {
    return clearRunningIndicator(previous, threadId);
  }

  if (DRAWER_HEARTBEAT_METHODS.has(event.method)) {
    return setRunningIndicator(previous, threadId, 'heartbeat', now);
  }

  return previous;
}

function resolveDrawerThreadRecord(
  params: Record<string, unknown> | null,
  msg: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return (
    toRecord(params?.['thread']) ??
    toRecord(params?.['threadState']) ??
    toRecord(params?.['thread_state']) ??
    toRecord(msg?.['thread'])
  );
}

function resolveDrawerSubagentSpawnRecord(
  source: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return toRecord(toRecord(source?.['subagent'] ?? source?.['subAgent'])?.['thread_spawn']);
}

interface DrawerThreadIdContext {
  msg: Record<string, unknown> | null;
  threadRecord: Record<string, unknown> | null;
  threadSourceRecord: Record<string, unknown> | null;
  turnRecord: Record<string, unknown> | null;
  sourceRecord: Record<string, unknown> | null;
  subagentThreadSpawnRecord: Record<string, unknown> | null;
  threadSubagentThreadSpawnRecord: Record<string, unknown> | null;
}

function buildDrawerThreadIdContext(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null,
): DrawerThreadIdContext {
  const msg = msgArg ?? toRecord(params?.['msg']);
  const threadRecord = resolveDrawerThreadRecord(params, msg);
  const threadSourceRecord = toRecord(threadRecord?.['source']);
  const turnRecord = toRecord(params?.['turn']) ?? toRecord(msg?.['turn']);
  const sourceRecord = toRecord(params?.['source']) ?? toRecord(msg?.['source']);
  return {
    msg,
    threadRecord,
    threadSourceRecord,
    turnRecord,
    sourceRecord,
    subagentThreadSpawnRecord: resolveDrawerSubagentSpawnRecord(sourceRecord),
    threadSubagentThreadSpawnRecord: resolveDrawerSubagentSpawnRecord(threadSourceRecord),
  };
}

function extractThreadIdFromMsg(msg: Record<string, unknown> | null): string | null {
  return (
    readNonEmptyString(msg?.['thread_id']) ??
    readNonEmptyString(msg?.['threadId']) ??
    readNonEmptyString(msg?.['conversation_id']) ??
    readNonEmptyString(msg?.['conversationId']) ??
    null
  );
}

function extractThreadIdFromParams(params: Record<string, unknown> | null): string | null {
  return (
    readNonEmptyString(params?.['thread_id']) ??
    readNonEmptyString(params?.['threadId']) ??
    readNonEmptyString(params?.['conversation_id']) ??
    readNonEmptyString(params?.['conversationId']) ??
    null
  );
}

function extractThreadIdFromThreadRecord(
  threadRecord: Record<string, unknown> | null,
): string | null {
  return (
    readNonEmptyString(threadRecord?.['id']) ??
    readNonEmptyString(threadRecord?.['thread_id']) ??
    readNonEmptyString(threadRecord?.['threadId']) ??
    readNonEmptyString(threadRecord?.['conversation_id']) ??
    readNonEmptyString(threadRecord?.['conversationId']) ??
    null
  );
}

function extractThreadIdFromTurnRecord(turnRecord: Record<string, unknown> | null): string | null {
  return (
    readNonEmptyString(turnRecord?.['thread_id']) ??
    readNonEmptyString(turnRecord?.['threadId']) ??
    null
  );
}

function extractThreadIdFromSourceRecord(
  sourceRecord: Record<string, unknown> | null,
): string | null {
  return (
    readNonEmptyString(sourceRecord?.['thread_id']) ??
    readNonEmptyString(sourceRecord?.['threadId']) ??
    readNonEmptyString(sourceRecord?.['conversation_id']) ??
    readNonEmptyString(sourceRecord?.['conversationId']) ??
    readNonEmptyString(sourceRecord?.['parent_thread_id']) ??
    readNonEmptyString(sourceRecord?.['parentThreadId']) ??
    null
  );
}

function extractParentThreadId(record: Record<string, unknown> | null): string | null {
  return (
    readNonEmptyString(record?.['parent_thread_id']) ??
    readNonEmptyString(record?.['parentThreadId']) ??
    null
  );
}

export function extractDrawerNotificationThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null,
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const ctx = buildDrawerThreadIdContext(params, msgArg);

  return (
    extractThreadIdFromMsg(ctx.msg) ??
    extractThreadIdFromParams(params) ??
    extractThreadIdFromThreadRecord(ctx.threadRecord) ??
    extractThreadIdFromTurnRecord(ctx.turnRecord) ??
    extractThreadIdFromSourceRecord(ctx.sourceRecord) ??
    extractParentThreadId(ctx.subagentThreadSpawnRecord) ??
    extractParentThreadId(ctx.threadSourceRecord) ??
    extractParentThreadId(ctx.threadSubagentThreadSpawnRecord) ??
    null
  );
}

function resolveDrawerStatusRecord(
  params: Record<string, unknown>,
  msg: Record<string, unknown> | null,
  threadRecord: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return (
    toRecord(params['status']) ?? toRecord(msg?.['status']) ?? toRecord(threadRecord?.['status'])
  );
}

function resolveDrawerStatusToken(
  params: Record<string, unknown>,
  msg: Record<string, unknown> | null,
  statusRecord: Record<string, unknown> | null,
  threadRecord: Record<string, unknown> | null,
): string | null {
  return (
    readString(params['status']) ??
    readString(msg?.['status']) ??
    readString(statusRecord?.['type']) ??
    readString(statusRecord?.['status']) ??
    readString(threadRecord?.['status'])
  );
}

export function extractDrawerStatusHint(params: Record<string, unknown> | null): string | null {
  if (!params) {
    return null;
  }

  const msg = toRecord(params['msg']);
  const threadRecord = resolveDrawerThreadRecord(params, msg);
  const statusRecord = resolveDrawerStatusRecord(params, msg, threadRecord);

  return normalizeToken(resolveDrawerStatusToken(params, msg, statusRecord, threadRecord));
}

function isDrawerRunIndicatorActive(
  indicator: DrawerRunIndicator | undefined,
  now: number,
): boolean {
  if (!indicator) {
    return false;
  }

  const ttl =
    indicator.source === 'lifecycle' ? RUN_LIFECYCLE_SAFETY_STALE_MS : RUN_HEARTBEAT_STALE_MS;
  return now - indicator.updatedAt < ttl;
}

function setRunningIndicator(
  previous: DrawerRunIndicatorMap,
  threadId: string,
  source: DrawerRunIndicator['source'],
  now: number,
): DrawerRunIndicatorMap {
  const existing = previous[threadId];
  const nextSource =
    existing?.source === 'lifecycle' || source === 'lifecycle' ? 'lifecycle' : 'heartbeat';
  const nextUpdatedAt = existing ? Math.max(existing.updatedAt, now) : now;
  if (
    existing &&
    existing.source === nextSource &&
    nextUpdatedAt - existing.updatedAt < RUN_INDICATOR_REFRESH_MIN_MS
  ) {
    return previous;
  }

  return {
    ...previous,
    [threadId]: {
      source: nextSource,
      updatedAt: nextUpdatedAt,
    },
  };
}

function clearRunningIndicator(
  previous: DrawerRunIndicatorMap,
  threadId: string,
): DrawerRunIndicatorMap {
  if (!(threadId in previous)) {
    return previous;
  }

  const next = { ...previous };
  delete next[threadId];
  return next;
}

function shouldChatSnapshotClearIndicator(
  chat: ChatSummary,
  indicator: DrawerRunIndicator,
): boolean {
  const snapshotStatusAt = parseTimestamp(chat.statusUpdatedAt) ?? parseTimestamp(chat.updatedAt);
  if (snapshotStatusAt === null) {
    return false;
  }

  return snapshotStatusAt + CHAT_STATUS_EVENT_SKEW_MS >= indicator.updatedAt;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  const text = readString(value)?.trim();
  return text ? text : null;
}
