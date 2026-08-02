import type { TurnPlanStep, TurnPlanUpdate } from '../../api/types';
import { readString, toRecord } from '../../runtimeValidation';
import type { ActivePlanState, ThreadContextUsage } from './mainScreenHelperTypes';

export function mergeThreadContextUsage(
  previous: ThreadContextUsage | null,
  next: ThreadContextUsage | null,
): ThreadContextUsage | null {
  if (!next) {
    return previous;
  }

  return {
    totalTokens: next.totalTokens ?? previous?.totalTokens ?? null,
    lastTokens: next.lastTokens ?? previous?.lastTokens ?? null,
    modelContextWindow: next.modelContextWindow ?? previous?.modelContextWindow ?? null,
    updatedAtMs: next.updatedAtMs,
  };
}

export function compactPlanDelta(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(-1200);
}

export function buildNextPlanStateFromDelta(
  previous: ActivePlanState | null,
  threadId: string,
  turnId: string,
  rawDelta: string,
): ActivePlanState {
  const sameTurn = previous && previous.threadId === threadId && previous.turnId === turnId;
  const nextDelta = compactPlanDelta(sameTurn ? `${previous.deltaText}\n${rawDelta}` : rawDelta);

  return {
    threadId,
    turnId,
    explanation: sameTurn ? previous.explanation : null,
    steps: sameTurn ? previous.steps : [],
    deltaText: nextDelta,
    updatedAt: new Date().toISOString(),
  };
}

export function buildNextPlanStateFromUpdate(
  previous: ActivePlanState | null,
  next: {
    threadId: string;
    turnId: string;
    explanation: string | null;
    plan: TurnPlanStep[];
  },
): ActivePlanState {
  const sameTurn =
    previous && previous.threadId === next.threadId && previous.turnId === next.turnId;

  return {
    threadId: next.threadId,
    turnId: next.turnId,
    explanation: next.explanation,
    steps: next.plan,
    deltaText: sameTurn ? previous.deltaText : '',
    updatedAt: new Date().toISOString(),
  };
}

export function renderPlanStatusGlyph(status: TurnPlanStep['status']): string {
  if (status === 'completed') {
    return '✔';
  }
  if (status === 'inProgress') {
    return '□';
  }
  return '□';
}

export function toTurnPlanUpdate(
  value: unknown,
  fallbackThreadId: string | null = null,
): TurnPlanUpdate | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const threadId = readString(record['threadId']) ?? fallbackThreadId;
  const turnId = readString(record['turnId']);
  if (!threadId || !turnId) {
    return null;
  }

  const rawPlan = Array.isArray(record['plan']) ? record['plan'] : [];
  const plan: TurnPlanStep[] = rawPlan
    .map((item) => {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        return null;
      }

      const step = readString(itemRecord['step']);
      const status = readString(itemRecord['status']);
      if (!step || (status !== 'pending' && status !== 'inProgress' && status !== 'completed')) {
        return null;
      }

      return {
        step,
        status,
      } satisfies TurnPlanStep;
    })
    .filter((item): item is TurnPlanStep => item !== null);

  return {
    threadId,
    turnId,
    explanation: readString(record['explanation']),
    plan,
  };
}
