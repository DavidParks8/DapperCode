import { readString, toRecord } from '../runtimeValidation';
import {
  normalizeLifecycleStatus,
  type RawAcpSnapshot,
  type RawThread,
  type RawTurn,
} from './chatMappingRawTypesAndReaders';
import { normalizeType } from './chatMappingToolArgumentParsers';
import { toPlanSnapshot } from './chatMappingPlanParsing';
import type { ChatPlanSnapshot } from './types';

export function extractChatPlans(raw: RawThread): {
  latestPlan: ChatPlanSnapshot | null;
  latestTurnPlan: ChatPlanSnapshot | null;
  latestTurnStatus: string | null;
  activeTurnId: string | null;
} {
  const threadId = raw.id?.trim();
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const latestTurn = turns.at(-1) ?? null;
  const latestTurnStatus = readString(latestTurn?.status);
  const activeTurnId = extractActiveTurnId(turns);
  const snapshot = raw.acpSnapshot;
  if (threadId && snapshot) {
    return extractSnapshotPlans(snapshot, threadId);
  }
  if (!threadId || turns.length === 0) {
    return {
      latestPlan: null,
      latestTurnPlan: null,
      latestTurnStatus,
      activeTurnId,
    };
  }
  return extractTurnPlans(turns, threadId, latestTurn, latestTurnStatus, activeTurnId);
}

function extractSnapshotPlans(
  snapshot: RawAcpSnapshot,
  threadId: string,
): ReturnType<typeof extractChatPlans> {
  const steps = snapshot.plan.map((entry) => ({
    step: entry.content,
    status: snapshotPlanStepStatus(entry.status),
  }));
  const plan =
    steps.length > 0
      ? {
          threadId,
          turnId: snapshot.active.sourceTurnId ?? `${threadId}::snapshot`,
          explanation: null,
          steps,
        }
      : null;
  return {
    latestPlan: plan,
    latestTurnPlan: plan,
    latestTurnStatus: snapshot.active.runId ? 'running' : 'completed',
    activeTurnId: snapshot.active.sourceTurnId ?? null,
  };
}

function snapshotPlanStepStatus(status: string): 'completed' | 'inProgress' | 'pending' {
  if (status === 'completed') {
    return 'completed';
  }
  return status === 'inProgress' || status === 'in_progress' ? 'inProgress' : 'pending';
}

function extractTurnPlans(
  turns: RawTurn[],
  threadId: string,
  latestTurn: RawTurn | null,
  latestTurnStatus: string | null,
  activeTurnId: string | null,
): ReturnType<typeof extractChatPlans> {
  let latestPlan: ChatPlanSnapshot | null = null;
  let latestTurnPlan: ChatPlanSnapshot | null = null;
  for (const turn of turns) {
    const turnId = readString(turn.id);
    const items = Array.isArray(turn.items) ? turn.items : [];
    let latestPlanInTurn: ChatPlanSnapshot | null = null;
    for (const item of items) {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        continue;
      }
      const itemType = normalizeType(readString(itemRecord['type']) ?? '');
      if (itemType !== 'plan') {
        continue;
      }
      const plan = toPlanSnapshot(itemRecord, threadId, turnId);
      if (!plan) {
        continue;
      }
      latestPlan = plan;
      latestPlanInTurn = plan;
    }
    if (turn === latestTurn) {
      latestTurnPlan = latestPlanInTurn;
    }
  }
  return { latestPlan, latestTurnPlan, latestTurnStatus, activeTurnId };
}

export function extractActiveTurnId(turns: RawTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    const turnId = readString(turn.id)?.trim();
    const turnStatus = normalizeLifecycleStatus(readString(turn.status));
    if (
      turnId &&
      (turnStatus === 'inprogress' ||
        turnStatus === 'running' ||
        turnStatus === 'active' ||
        turnStatus === 'queued' ||
        turnStatus === 'pending')
    ) {
      return turnId;
    }
  }
  return null;
}
