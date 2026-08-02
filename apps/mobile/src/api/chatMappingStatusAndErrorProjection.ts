import { readString, toRecord } from '../runtimeValidation';
import {
  normalizeLifecycleStatus,
  type RawAcpSnapshot,
  type RawThread,
  type RawThreadStatus,
  type RawTurn,
  readTimestampSeconds,
} from './chatMappingRawTypesAndReaders';
import { toRawAcpSnapshot, toRawTurn } from './chatMappingSnapshotAndSummaryProjection';
import type { ChatStatus } from './types';

const RUNNING_STATUSES = new Set(['inprogress', 'running', 'active', 'queued', 'pending']);
const ERROR_STATUSES = new Set([
  'failed',
  'interrupted',
  'error',
  'aborted',
  'cancelled',
  'canceled',
]);
const COMPLETED_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded']);

export function readErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }
  const direct = readString(value)?.trim();
  if (direct) {
    return direct;
  }
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const fields = [
    record['message'],
    record['errorMessage'],
    record['error_message'],
    record['detail'],
    record['details'],
    record['reason'],
    record['description'],
    record['stderr'],
    record['error'],
  ];
  for (const field of fields) {
    const message = readErrorMessage(field, depth + 1);
    if (message) {
      return message;
    }
  }
  return null;
}

/**
 * Whether the thread has a prompt in flight right now.
 *
 * The ACP bridge reports no thread lifecycle status at all — its `thread/read` payload carries
 * only the snapshot — so `mapRawStatus` would settle every thread, running or not, on `idle`.
 * `acpSnapshot.active` is the authoritative live signal: the bridge sets it on `RunStarted` and
 * clears it on `RunFinished`/`RunFailed`. Without it a turn that goes quiet — which is exactly
 * what a parent thread does for the whole of a sub-agent run — looks finished, the run watchdog
 * expires, and the composer settles on "Ready" while the agent is still working.
 */
export function hasActiveAcpRun(acpSnapshot: RawAcpSnapshot | undefined): boolean {
  const active = acpSnapshot?.active;
  if (!active) {
    return false;
  }
  return Boolean(active.runId ?? active.sourceTurnId) || active.generation != null;
}

export function mapRawStatus(status: unknown, turns: RawTurn[] | undefined): ChatStatus {
  const statusRecord = toRecord(status);
  const statusType = normalizeLifecycleStatus(
    readString(statusRecord?.['type']) ?? readString(status),
  );
  const hasTurns = Array.isArray(turns) && turns.length > 0;
  const lastTurn = hasTurns ? turns[turns.length - 1] : null;
  const lastTurnStatus = normalizeLifecycleStatus(readString(lastTurn?.status));
  const isIdleLikeStatus = statusType === 'idle' || statusType === 'notloaded';
  const turnStatus = mapLastTurnStatus(lastTurnStatus, hasTurns, isIdleLikeStatus);
  if (turnStatus) {
    return turnStatus;
  }
  return mapThreadLifecycleStatus(statusType, hasTurns, isIdleLikeStatus);
}

function mapLastTurnStatus(
  status: string | null,
  hasTurns: boolean,
  isIdleLikeStatus: boolean,
): ChatStatus | null {
  const knownStatus = status ?? '';
  if (RUNNING_STATUSES.has(knownStatus)) {
    return isIdleLikeStatus ? (hasTurns ? 'complete' : 'idle') : 'running';
  }
  if (ERROR_STATUSES.has(knownStatus)) {
    return 'error';
  }
  return COMPLETED_STATUSES.has(knownStatus) ? 'complete' : null;
}

function mapThreadLifecycleStatus(
  statusType: string | null,
  hasTurns: boolean,
  isIdleLikeStatus: boolean,
): ChatStatus {
  const knownStatus = statusType ?? '';
  if (knownStatus === 'systemerror' || knownStatus === 'error' || knownStatus === 'failed') {
    return 'error';
  }
  if (RUNNING_STATUSES.has(knownStatus) && knownStatus !== 'active') {
    return 'running';
  }
  if (knownStatus === 'active') {
    // Some backends keep a thread "active" while loaded in memory even when no // turn is running. If there is no in-progress turn, avoid false "working" UI.
    return hasTurns ? 'complete' : 'idle';
  }
  if (isIdleLikeStatus) {
    return hasTurns ? 'complete' : 'idle';
  }
  return 'idle';
}

export function extractLastError(turns: RawTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) {
      continue;
    }
    const turnStatus = normalizeLifecycleStatus(readString(turn.status));
    if (turnStatus === null || !ERROR_STATUSES.has(turnStatus)) {
      continue;
    }
    const message = readTurnErrorMessage(turn);
    if (message) {
      return message;
    }
    return `turn ${turnStatus}`;
  }
  return null;
}

function readTurnErrorMessage(turn: RawTurn): string | null {
  for (const value of [
    turn.error,
    turn.message,
    turn.errorMessage,
    turn.error_message,
    turn.detail,
    turn.details,
    turn.reason,
    turn.description,
    turn.stderr,
  ]) {
    const message = readErrorMessage(value);
    if (message) {
      return message;
    }
  }
  return null;
}

export function toRawThread(value: unknown): RawThread {
  const record = toRecord(value) ?? {};
  const threadName = firstString(
    record['name'],
    record['title'],
    record['threadName'],
    record['thread_name'],
  );
  return {
    id: readString(record['id']) ?? undefined,
    agentId: record['agentId'],
    name: threadName,
    title: threadName,
    preview: readString(record['preview']) ?? undefined,
    modelProvider: readString(record['modelProvider']) ?? undefined,
    agentNickname: firstString(record['agentNickname'], record['agent_nickname']),
    agentRole: firstString(record['agentRole'], record['agent_role']),
    createdAt: readTimestampSeconds(record['createdAt']) ?? undefined,
    updatedAt: readTimestampSeconds(record['updatedAt']) ?? undefined,
    status: (record['status'] as RawThreadStatus) ?? undefined,
    cwd: readString(record['cwd']) ?? undefined,
    source: record['source'],
    acpSnapshot: toRawAcpSnapshot(record['acpSnapshot']),
    turns: Array.isArray(record['turns'])
      ? (record['turns'].map((turn) => toRawTurn(turn)).filter(Boolean) as RawTurn[])
      : undefined,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = readString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}
