import { activePlanAtom, activeTurnIdAtom, stoppingTurnAtom } from '../../state/mainScreen/turn';
import { selectedCollaborationModeAtom } from '../../state/mainScreen/models';
import { screenSetter } from '../../state/mainScreen/registry';
import { activityAtom } from '../../state/mainScreen/composer';
import type { RpcNotification } from '../../api/types';
import { lookupDispatchEntry, readString, toRecord } from '../../runtimeValidation';
import { mergeChatSummaryPreservingMessages } from './mainScreenChatState';
import {
  RUN_WATCHDOG_MS,
  EXTERNAL_RUNNING_STATUS_HINTS,
  EXTERNAL_ERROR_STATUS_HINTS,
  EXTERNAL_COMPLETE_STATUS_HINTS,
  buildNextPlanStateFromUpdate,
  toTurnPlanUpdate,
  describeCompletedToolEvent,
  extractNotificationThreadId,
  extractExternalStatusHint,
  isChatSummaryLikelyRunning,
} from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';

type TurnLifecycleEventMethod =
  | 'item/commandExecution/outputDelta'
  | 'item/mcpToolCall/progress'
  | 'item/commandExecution/terminalInteraction'
  | 'turn/plan/updated'
  | 'turn/diff/updated'
  | 'item/completed'
  | 'thread/status/changed';

export function processTurnLifecycleEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
): void {
  const handler = lookupDispatchEntry(TURN_LIFECYCLE_EVENT_HANDLERS, event.method);
  if (!handler) {
    return;
  }

  handler(
    createTurnLifecycleEventContext(context),
    event,
    currentId,
    pendingApprovalId,
    pendingUserInputRequestId,
  );
}

type TurnLifecycleEventContext = ReturnType<typeof createTurnLifecycleEventContext>;
type TurnLifecycleEventHandler = (
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
) => void;

type ThreadSummary = Awaited<ReturnType<MainScreenWsEventRouterContext['api']['getChatSummary']>>;

const TURN_LIFECYCLE_EVENT_HANDLERS: Record<TurnLifecycleEventMethod, TurnLifecycleEventHandler> = {
  'item/commandExecution/outputDelta': handleCommandOutputDeltaEvent,
  'item/mcpToolCall/progress': handleMcpToolProgressEvent,
  'item/commandExecution/terminalInteraction': handleTerminalInteractionEvent,
  'turn/plan/updated': handleTurnPlanUpdatedEvent,
  'turn/diff/updated': handleTurnDiffUpdatedEvent,
  'item/completed': handleItemCompletedEvent,
  'thread/status/changed': handleThreadStatusChangedEvent,
};

function createTurnLifecycleEventContext(context: MainScreenWsEventRouterContext) {
  const { store } = context;
  return {
    ...context,
    setActivePlan: screenSetter(store, activePlanAtom),
    setActiveTurnId: screenSetter(store, activeTurnIdAtom),
    setStoppingTurn: screenSetter(store, stoppingTurnAtom),
    setSelectedCollaborationMode: screenSetter(store, selectedCollaborationModeAtom),
    setActivity: screenSetter(store, activityAtom),
  };
}

function handleCommandOutputDeltaEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  handleWorkingLifecycleEvent(context, event, currentId, false);
}

function handleMcpToolProgressEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  handleWorkingLifecycleEvent(context, event, currentId, false);
}

function handleTerminalInteractionEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  handleWorkingLifecycleEvent(context, event, currentId, true);
}

function handleTurnDiffUpdatedEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  handleWorkingLifecycleEvent(context, event, currentId, true);
}

function handleWorkingLifecycleEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
  replaceCurrentActivity: boolean,
): void {
  const params = toRecord(event.params);
  const threadId = readNotificationThreadId(params, currentId, false);
  if (!threadId) {
    return;
  }

  if (threadId !== currentId) {
    cacheRunningThreadActivity(context, threadId, 'Working');
    return;
  }

  context.bumpRunWatchdog();
  if (replaceCurrentActivity) {
    context.setActivity({
      tone: 'running',
      title: 'Working',
    });
    return;
  }

  context.setActivity((prev) =>
    prev.tone === 'running' && prev.title === 'Working'
      ? prev
      : {
          tone: 'running',
          title: 'Working',
        },
  );
}

function handleTurnPlanUpdatedEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const params = toRecord(event.params);
  const threadId = readNotificationThreadId(params, currentId, true);
  if (!threadId) {
    return;
  }

  const planUpdate = toTurnPlanUpdate(params, threadId);
  if (threadId !== currentId) {
    cacheRunningThreadActivity(context, threadId, 'Planning');
    if (planUpdate) {
      context.cacheThreadPlan(threadId, (previous) =>
        buildNextPlanStateFromUpdate(previous, planUpdate),
      );
    }
    return;
  }

  context.setSelectedCollaborationMode('plan');
  context.bumpRunWatchdog();
  if (planUpdate) {
    context.setActivePlan((prev) => buildNextPlanStateFromUpdate(prev, planUpdate));
    context.cacheThreadPlan(threadId, (previous) =>
      buildNextPlanStateFromUpdate(previous, planUpdate),
    );
  }
  context.setActivity({
    tone: 'running',
    title: 'Planning',
  });
}

function handleItemCompletedEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const params = toRecord(event.params);
  const threadId = readNotificationThreadId(params, currentId, false);
  if (!threadId) {
    return;
  }

  const item = toRecord(params?.item);
  if (threadId !== currentId) {
    handleNonCurrentItemCompleted(context, threadId, item);
    return;
  }

  handleCurrentItemCompleted(context, threadId, item);
}

function handleNonCurrentItemCompleted(
  context: TurnLifecycleEventContext,
  threadId: string,
  item: Record<string, unknown> | null,
): void {
  const completedToolEvent = describeCompletedToolEvent(item);
  if (completedToolEvent) {
    context.cacheThreadActiveCommand(
      threadId,
      completedToolEvent.eventType,
      completedToolEvent.detail,
    );
  }

  if (readString(item?.type) !== 'commandExecution') {
    return;
  }

  context.cacheThreadActivity(threadId, buildCompletedCommandActivity(item));
}

function handleCurrentItemCompleted(
  context: TurnLifecycleEventContext,
  threadId: string,
  item: Record<string, unknown> | null,
): void {
  const completedToolEvent = describeCompletedToolEvent(item);
  if (completedToolEvent) {
    context.cacheThreadActiveCommand(
      threadId,
      completedToolEvent.eventType,
      completedToolEvent.detail,
    );
    context.pushActiveCommand(threadId, completedToolEvent.eventType, completedToolEvent.detail);
  }

  const itemType = readString(item?.type);
  if (itemType === 'reasoning') {
    // The completed item carries the settled reasoning, so the live buffer stops
    // owning the message and the card collapses to its compact form.
    context.clearLiveReasoningMessage(threadId);
  }

  if (itemType !== 'commandExecution') {
    return;
  }

  context.hadCommandRef.current = true;
  context.setActivity(buildCompletedCommandActivity(item));
}

function buildCompletedCommandActivity(item: Record<string, unknown> | null) {
  const failed = isFailedCommandExecution(item);
  return {
    tone: failed ? 'error' : 'running',
    title: failed ? 'Turn failed' : 'Working',
  } as const;
}

function isFailedCommandExecution(item: Record<string, unknown> | null): boolean {
  const status = readString(item?.status);
  return status === 'failed' || status === 'error';
}

function handleThreadStatusChangedEvent(
  context: TurnLifecycleEventContext,
  event: RpcNotification,
  currentId: string | null,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
): void {
  const params = toRecord(event.params);
  const threadId = extractNotificationThreadId(params);
  if (!threadId) {
    return;
  }

  const statusHint = extractExternalStatusHint(params);
  const hasExplicitRunningStatus = Boolean(
    statusHint && EXTERNAL_RUNNING_STATUS_HINTS.has(statusHint),
  );
  const hasExplicitTerminalStatus = Boolean(statusHint && isExternalTerminalStatusHint(statusHint));
  if (threadId === currentId) {
    handleCurrentThreadStatusChanged(
      context,
      threadId,
      statusHint,
      hasExplicitRunningStatus,
      hasExplicitTerminalStatus,
      pendingApprovalId,
      pendingUserInputRequestId,
    );
    context.scheduleExternalStatusFullSync(threadId);
    return;
  }

  handleOtherThreadStatusChanged(context, threadId, hasExplicitTerminalStatus);
}

function handleCurrentThreadStatusChanged(
  context: TurnLifecycleEventContext,
  threadId: string,
  statusHint: string | null,
  hasExplicitRunningStatus: boolean,
  hasExplicitTerminalStatus: boolean,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
): void {
  if (!hasExplicitTerminalStatus) {
    context.bumpRunWatchdog();
    context.setActivity((prev) =>
      prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' },
    );
  }

  context.api
    .getChatSummary(threadId)
    .then((summary) => {
      applyExternalThreadSummary(
        context,
        threadId,
        summary,
        statusHint,
        hasExplicitRunningStatus,
        hasExplicitTerminalStatus,
        pendingApprovalId,
        pendingUserInputRequestId,
      );
    })
    .catch(() => {});
}

function applyExternalThreadSummary(
  context: TurnLifecycleEventContext,
  threadId: string,
  summary: ThreadSummary,
  statusHint: string | null,
  hasExplicitRunningStatus: boolean,
  hasExplicitTerminalStatus: boolean,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
): void {
  if (context.chatIdRef.current !== threadId) {
    return;
  }

  context.setSelectedChat((prev) => {
    if (!prev || prev.id !== summary.id) {
      return prev;
    }
    return mergeChatSummaryPreservingMessages(prev, summary);
  });

  if (
    shouldShowExternalThreadAsRunning(
      context,
      summary,
      hasExplicitRunningStatus,
      hasExplicitTerminalStatus,
    )
  ) {
    context.bumpRunWatchdog();
    context.setActivity((prev) =>
      prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' },
    );
    return;
  }

  resetSettledExternalThreadState(
    context,
    threadId,
    summary,
    statusHint,
    pendingApprovalId,
    pendingUserInputRequestId,
  );
}

function shouldShowExternalThreadAsRunning(
  context: TurnLifecycleEventContext,
  summary: ThreadSummary,
  hasExplicitRunningStatus: boolean,
  hasExplicitTerminalStatus: boolean,
): boolean {
  const shouldPreserveRunning =
    !hasExplicitTerminalStatus && context.runWatchdogUntilRef.current > Date.now();
  return hasExplicitRunningStatus || isChatSummaryLikelyRunning(summary) || shouldPreserveRunning;
}

function resetSettledExternalThreadState(
  context: TurnLifecycleEventContext,
  threadId: string,
  summary: ThreadSummary,
  statusHint: string | null,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
): void {
  context.clearRunWatchdog();
  context.cacheThreadTurnState(threadId, {
    activeTurnId: null,
    runWatchdogUntil: 0,
  });
  context.setActiveTurnId(null);
  context.setStoppingTurn(false);
  if (pendingApprovalId || pendingUserInputRequestId) {
    return;
  }

  context.setActiveCommands([]);
  context.setStreamingText(null);
  context.reasoningSummaryRef.current = {};
  context.reasoningBufferRef.current = '';
  context.hadCommandRef.current = false;
  context.setActivity(() => buildSettledExternalThreadActivity(statusHint, summary));
}

function buildSettledExternalThreadActivity(statusHint: string | null, summary: ThreadSummary) {
  if (statusHint && EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint)) {
    return {
      tone: 'complete',
      title: 'Turn completed',
    } as const;
  }

  if (summary.status === 'error') {
    return {
      tone: 'error',
      title: 'Turn failed',
      detail: summary.lastError ?? undefined,
    } as const;
  }

  return summary.status === 'complete'
    ? ({
        tone: 'complete',
        title: 'Turn completed',
      } as const)
    : ({
        tone: 'idle',
        title: 'Ready',
      } as const);
}

function handleOtherThreadStatusChanged(
  context: TurnLifecycleEventContext,
  threadId: string,
  hasExplicitTerminalStatus: boolean,
): void {
  if (!hasExplicitTerminalStatus) {
    cacheRunningThreadActivity(context, threadId, 'Working');
  }
  void context.refreshPendingApprovalsForThread(threadId);
}

function cacheRunningThreadActivity(
  context: TurnLifecycleEventContext,
  threadId: string,
  title: 'Working' | 'Planning',
): void {
  context.cacheThreadTurnState(threadId, {
    runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
  });
  context.cacheThreadActivity(threadId, {
    tone: 'running',
    title,
  });
}

function readNotificationThreadId(
  params: Record<string, unknown> | null,
  fallbackThreadId: string | null,
  allowFallbackThreadId: boolean,
): string | null {
  return (
    readString(params?.threadId) ??
    readString(params?.thread_id) ??
    (allowFallbackThreadId ? fallbackThreadId : null)
  );
}

function isExternalTerminalStatusHint(statusHint: string): boolean {
  return (
    EXTERNAL_ERROR_STATUS_HINTS.has(statusHint) || EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint)
  );
}
