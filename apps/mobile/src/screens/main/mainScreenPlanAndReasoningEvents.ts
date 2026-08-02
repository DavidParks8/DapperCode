import type { RpcNotification } from '../../api/types';
import { readFiniteNumber, readString, toRecord } from '../../runtimeValidation';
import { screenSetter } from '../../state/mainScreen/registry';
import { selectedCollaborationModeAtom } from '../../state/mainScreen/models';
import { activePlanAtom } from '../../state/mainScreen/turn';
import {
  RUN_WATCHDOG_MS,
  type ActivePlanState,
  buildNextPlanStateFromDelta,
  extractFirstBoldSnippet,
  toReasoningActivityDetail,
} from './mainScreenHelpers';
import type { ActivityState } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';

export type SetActivity = (
  update: ActivityState | ((previous: ActivityState) => ActivityState),
) => void;

type PlanAndReasoningProcessingContext = {
  context: MainScreenWsEventRouterContext;
  currentId: string | null;
  setActivity: SetActivity;
  setSelectedCollaborationMode: (mode: 'plan') => void;
  setActivePlan: (
    update: ActivePlanState | null | ((previous: ActivePlanState | null) => ActivePlanState | null),
  ) => void;
};

function readThreadId(params: Record<string, unknown> | null): string | null {
  return readString(params?.['threadId']) ?? readString(params?.['thread_id']);
}

function readSummaryKey(params: Record<string, unknown> | null): string | null {
  const itemId = readString(params?.['itemId']);
  const summaryIndex = readFiniteNumber(params?.['summaryIndex']);
  if (!itemId || summaryIndex === null) {
    return null;
  }

  return `${itemId}:${String(summaryIndex)}`;
}

function cacheRunWatchdog(
  context: MainScreenWsEventRouterContext,
  threadId: string,
  title?: string,
  detail?: string,
): void {
  context.cacheThreadTurnState(threadId, {
    runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
  });

  if (!title) {
    return;
  }

  context.cacheThreadActivity(threadId, {
    tone: 'running',
    title,
    detail,
  });
}

function cachePlanDelta(
  context: MainScreenWsEventRouterContext,
  threadId: string,
  turnId: string,
  rawDelta: string,
): void {
  context.cacheThreadPlan(threadId, (previous) =>
    buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta),
  );
}

function setPlanningActivity(setActivity: SetActivity): void {
  setActivity((prev) =>
    prev.tone === 'running' && prev.title === 'Planning'
      ? prev
      : {
          tone: 'running',
          title: 'Planning',
        },
  );
}

function resolveReasoningActivity(buffer: string): { title: string; detail: string | undefined } {
  const heading = extractFirstBoldSnippet(buffer, 56);
  return {
    title: heading ?? 'Working',
    detail: heading ? undefined : toReasoningActivityDetail(buffer, heading, 64),
  };
}

function accumulateReasoningSummaryDelta(
  reasoningSummaryRef: MainScreenWsEventRouterContext['reasoningSummaryRef'],
  summaryKey: string | null,
  delta: string | null,
): { heading: string | null; detail: string | undefined } {
  const baseText = delta ?? '';
  let accumulated = baseText;
  if (summaryKey) {
    accumulated = `${reasoningSummaryRef.current[summaryKey] ?? ''}${baseText}`;
    reasoningSummaryRef.current[summaryKey] = accumulated;
  }

  const heading = extractFirstBoldSnippet(accumulated, 56) ?? extractFirstBoldSnippet(baseText, 56);
  return {
    heading,
    detail: heading ? undefined : toReasoningActivityDetail(accumulated, heading, 64),
  };
}

function setReasoningActivity(
  setActivity: SetActivity,
  heading: string | null,
  detail: string | undefined,
): void {
  setActivity((prev) => {
    const title =
      heading ?? (prev.tone === 'running' && prev.title.trim() ? prev.title : 'Working');
    if (prev.tone === 'running' && prev.title === title && prev.detail === detail) {
      return prev;
    }

    return {
      tone: 'running',
      title,
      detail,
    };
  });
}

function handlePlanDelta(
  processing: PlanAndReasoningProcessingContext,
  event: RpcNotification,
): void {
  const params = toRecord(event.params);
  const threadId = readThreadId(params);
  if (!threadId) {
    return;
  }

  const turnId = readString(params?.['turnId']) ?? 'unknown-turn';
  processing.context.planItemTurnIdByThreadRef.current[threadId] = turnId;

  if (threadId !== processing.currentId) {
    const rawDelta = readString(params?.['delta']) ?? '';
    cacheRunWatchdog(processing.context, threadId, 'Planning');
    cachePlanDelta(processing.context, threadId, turnId, rawDelta);
    return;
  }

  processing.setSelectedCollaborationMode('plan');
  processing.context.bumpRunWatchdog();
  const rawDelta = readString(params?.['delta']) ?? '';
  processing.setActivePlan((prev) => buildNextPlanStateFromDelta(prev, threadId, turnId, rawDelta));
  cachePlanDelta(processing.context, threadId, turnId, rawDelta);
  setPlanningActivity(processing.setActivity);
}

function handleReasoningSummaryPartAdded(
  processing: PlanAndReasoningProcessingContext,
  event: RpcNotification,
): void {
  const params = toRecord(event.params);
  const threadId = readThreadId(params);
  if (!threadId) {
    return;
  }

  if (threadId !== processing.currentId) {
    cacheRunWatchdog(processing.context, threadId);
    return;
  }

  processing.context.bumpRunWatchdog();
  const summaryKey = readSummaryKey(params);
  if (summaryKey && processing.context.reasoningSummaryRef.current[summaryKey] === undefined) {
    processing.context.reasoningSummaryRef.current[summaryKey] = '';
  }
}

function handleReasoningSummaryTextDelta(
  processing: PlanAndReasoningProcessingContext,
  event: RpcNotification,
): void {
  const params = toRecord(event.params);
  const threadId = readThreadId(params);
  if (!threadId) {
    return;
  }

  const delta = readString(params?.['delta']);
  if (threadId !== processing.currentId) {
    if (!delta) {
      return;
    }

    const buffer = `${processing.context.threadReasoningBuffersRef.current[threadId] ?? ''}${delta}`;
    processing.context.threadReasoningBuffersRef.current[threadId] = buffer;
    const nextActivity = resolveReasoningActivity(buffer);
    cacheRunWatchdog(processing.context, threadId, nextActivity.title, nextActivity.detail);
    return;
  }

  processing.context.bumpRunWatchdog();
  const { heading, detail } = accumulateReasoningSummaryDelta(
    processing.context.reasoningSummaryRef,
    readSummaryKey(params),
    delta,
  );
  setReasoningActivity(processing.setActivity, heading, detail);
}

function handleReasoningTextDelta(
  processing: PlanAndReasoningProcessingContext,
  event: RpcNotification,
): void {
  const params = toRecord(event.params);
  const threadId = readThreadId(params);
  if (!threadId) {
    return;
  }

  if (threadId !== processing.currentId) {
    cacheRunWatchdog(processing.context, threadId);
    return;
  }

  processing.context.bumpRunWatchdog();
  const delta = readString(params?.['delta']);
  if (delta) {
    processing.context.upsertLiveReasoningMessage(threadId, delta);
  }
  processing.setActivity((prev) =>
    prev.tone === 'running'
      ? prev
      : {
          tone: 'running',
          title: 'Working',
        },
  );
}

export function processPlanAndReasoningEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null,
  setActivity: SetActivity,
): void {
  const setSelectedCollaborationMode = screenSetter(context.store, selectedCollaborationModeAtom);
  const setActivePlan = screenSetter(context.store, activePlanAtom);
  const processing: PlanAndReasoningProcessingContext = {
    context,
    currentId,
    setActivity,
    setSelectedCollaborationMode,
    setActivePlan,
  };

  switch (event.method) {
    case 'item/plan/delta':
      handlePlanDelta(processing, event);
      return;
    case 'item/reasoning/summaryPartAdded':
      handleReasoningSummaryPartAdded(processing, event);
      return;
    case 'item/reasoning/summaryTextDelta':
      handleReasoningSummaryTextDelta(processing, event);
      return;
    case 'item/reasoning/textDelta':
      handleReasoningTextDelta(processing, event);
      return;
    default:
      return;
  }
}
