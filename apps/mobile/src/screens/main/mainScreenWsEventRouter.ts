import { pendingApprovalAtom, pendingUserInputRequestAtom } from '../../state/mainScreen/turn';
import { processTurnLifecycleEvents } from './mainScreenTurnLifecycleEvents';
import { processAgUiRunEvents } from './mainScreenAgUiRunEvents';
import { processThreadStateEvents } from './mainScreenThreadStateEvents';
import { processPlanAndReasoningEvents } from './mainScreenPlanAndReasoningEvents';
import { processBridgeInteractionEvents } from './mainScreenBridgeInteractionEvents';
import { processBridgeConnectionEvents } from './mainScreenBridgeConnectionEvents';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { activityAtom } from '../../state/mainScreen/composer';
import type { RpcNotification } from '../../api/types';
import { parseAgUiEventNotification } from '../../api/agUi';
import type {
  MainScreenReplayRecoveryEngineContext,
  MainScreenReplayRecoveryEngineResult,
} from './mainScreenReplayRecoveryEngine';

export type MainScreenWsEventRouterContext = MainScreenReplayRecoveryEngineContext &
  MainScreenReplayRecoveryEngineResult;

type MainScreenWsEventRoute =
  | 'agUi'
  | 'threadState'
  | 'planAndReasoning'
  | 'turnLifecycle'
  | 'bridgeConnection'
  | 'bridgeInteraction';

const THREAD_STATE_EVENT_METHODS = new Set([
  'bridge/events/snapshotRequired',
  'thread/name/updated',
  'thread/deleted',
  'thread/tokenUsage/updated',
  'item/started',
]);

const PLAN_AND_REASONING_EVENT_METHODS = new Set([
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/mcpToolCall/progress',
  'item/commandExecution/terminalInteraction',
]);

const TURN_LIFECYCLE_EVENT_METHODS = new Set([
  'turn/plan/updated',
  'turn/diff/updated',
  'item/completed',
  'thread/status/changed',
]);

export function useMainScreenWsEventRouter(context: MainScreenWsEventRouterContext) {
  const {
    api,
    appendStopSystemMessageIfNeeded,
    bumpAgentRuntimeRevision,
    bumpRunWatchdog,
    cacheThreadActiveCommand,
    cacheThreadActivity,
    cacheThreadBridgeUiSurface,
    cacheThreadContextUsage,
    cacheThreadPendingApproval,
    cacheThreadPendingUserInputRequest,
    cacheThreadPlan,
    cacheThreadTurnState,
    clearDeferredDisconnectActivity,
    clearLiveReasoningMessage,
    clearPendingPlanImplementationPrompt,
    clearRunWatchdog,
    loadChat,
    pushActiveCommand,
    readThreadContextUsage,
    recoverReplayGap,
    refreshPendingApprovalsForThread,
    registerTurnStarted,
    removeThreadBridgeUiSurface,
    replaceThreadBridgeUiSurfaces,
    scheduleAgentThreadsRefresh,
    scheduleDisconnectActivity,
    scheduleExternalStatusFullSync,
    scrollToBottomIfPinned,
    upsertLiveReasoningMessage,
    upsertThreadRuntimeSnapshot,
    ws,
  } = context;
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const setActivity = useSetAtom(activityAtom);
  const eventContextRef = useRef(context);
  const setActivityRef = useRef(setActivity);
  eventContextRef.current = context;
  setActivityRef.current = setActivity;

  useEffect(() => {
    const pendingApprovalId = pendingApproval?.requestId;
    const pendingUserInputRequestId = pendingUserInputRequest?.requestId;

    return ws.onEvent((event: RpcNotification) => {
      const eventContext = eventContextRef.current;
      const currentId = eventContext.chatIdRef.current;
      const route = getMainScreenWsEventRoute(event);
      if (!route) {
        return;
      }

      switch (route) {
        case 'agUi':
          processAgUiRunEvents(eventContext, event, currentId);
          return;
        case 'threadState':
          processThreadStateEvents(eventContext, event, currentId);
          return;
        case 'planAndReasoning':
          processPlanAndReasoningEvents(eventContext, event, currentId, setActivityRef.current);
          return;
        case 'turnLifecycle':
          processTurnLifecycleEvents(
            eventContext,
            event,
            currentId,
            pendingApprovalId,
            pendingUserInputRequestId,
          );
          return;
        case 'bridgeConnection':
          processBridgeConnectionEvents(eventContext, event, currentId);
          return;
        case 'bridgeInteraction':
          processBridgeInteractionEvents(
            eventContext,
            event,
            currentId,
            pendingApprovalId,
            pendingUserInputRequestId,
          );
      }
    });
  }, [
    ws,
    api,
    pendingApproval?.requestId,
    pendingUserInputRequest?.requestId,
    recoverReplayGap,
    loadChat,
    scheduleAgentThreadsRefresh,
    appendStopSystemMessageIfNeeded,
    bumpRunWatchdog,
    bumpAgentRuntimeRevision,
    clearDeferredDisconnectActivity,
    cacheThreadActiveCommand,
    cacheThreadActivity,
    cacheThreadContextUsage,
    cacheThreadBridgeUiSurface,
    cacheThreadPendingApproval,
    cacheThreadPendingUserInputRequest,
    cacheThreadPlan,
    cacheThreadTurnState,
    clearPendingPlanImplementationPrompt,
    clearLiveReasoningMessage,
    clearRunWatchdog,
    readThreadContextUsage,
    replaceThreadBridgeUiSurfaces,
    refreshPendingApprovalsForThread,
    removeThreadBridgeUiSurface,
    scheduleDisconnectActivity,
    scheduleExternalStatusFullSync,
    registerTurnStarted,
    pushActiveCommand,
    scrollToBottomIfPinned,
    upsertLiveReasoningMessage,
    upsertThreadRuntimeSnapshot,
  ]);

  return {};
}

export type MainScreenWsEventRouterResult = ReturnType<typeof useMainScreenWsEventRouter>;

function getMainScreenWsEventRoute(event: RpcNotification): MainScreenWsEventRoute | null {
  if (parseAgUiEventNotification(event)) {
    return 'agUi';
  }

  return getMainScreenWsEventMethodRoute(event.method);
}

function getMainScreenWsEventMethodRoute(method: string): MainScreenWsEventRoute | null {
  if (THREAD_STATE_EVENT_METHODS.has(method)) {
    return 'threadState';
  }
  if (PLAN_AND_REASONING_EVENT_METHODS.has(method) || method.startsWith('item/reasoning/')) {
    return 'planAndReasoning';
  }
  if (TURN_LIFECYCLE_EVENT_METHODS.has(method)) {
    return 'turnLifecycle';
  }
  if (method === 'bridge/connection/state') {
    return 'bridgeConnection';
  }

  return method.startsWith('bridge/') ? 'bridgeInteraction' : null;
}
