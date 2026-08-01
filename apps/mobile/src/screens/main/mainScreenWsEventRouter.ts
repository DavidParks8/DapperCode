import { pendingApprovalAtom, pendingUserInputRequestAtom } from '../../state/mainScreen/turn';
import { processTurnLifecycleEvents } from './mainScreenTurnLifecycleEvents';
import { processAgUiRunEvents } from './mainScreenAgUiRunEvents';
import { processThreadStateEvents } from './mainScreenThreadStateEvents';
import { processPlanAndReasoningEvents } from './mainScreenPlanAndReasoningEvents';
import { processBridgeInteractionEvents } from './mainScreenBridgeInteractionEvents';
import { processBridgeConnectionEvents } from './mainScreenBridgeConnectionEvents';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { activityAtom } from '../../state/mainScreen/composer';
import type { RpcNotification } from '../../api/types';
import { parseAgUiEventNotification } from '../../api/agUi';
import type {
  MainScreenReplayRecoveryEngineContext,
  MainScreenReplayRecoveryEngineResult,
} from './mainScreenReplayRecoveryEngine';

export type MainScreenWsEventRouterContext = MainScreenReplayRecoveryEngineContext &
  MainScreenReplayRecoveryEngineResult;

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
    chatIdRef,
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

  useEffect(() => {
    const pendingApprovalId = pendingApproval?.requestId;
    const pendingUserInputRequestId = pendingUserInputRequest?.requestId;

    return ws.onEvent((event: RpcNotification) => {
      const currentId = chatIdRef.current;
      if (parseAgUiEventNotification(event)) {
        processAgUiRunEvents(context, event, currentId);
        return;
      }
      if (
        event.method === 'bridge/events/snapshotRequired' ||
        event.method === 'thread/name/updated' ||
        event.method === 'thread/deleted' ||
        event.method === 'thread/tokenUsage/updated' ||
        event.method === 'item/started'
      ) {
        processThreadStateEvents(context, event, currentId);
        return;
      }
      if (
        event.method === 'item/plan/delta' ||
        event.method.startsWith('item/reasoning/') ||
        event.method === 'item/commandExecution/outputDelta' ||
        event.method === 'item/mcpToolCall/progress' ||
        event.method === 'item/commandExecution/terminalInteraction'
      ) {
        processPlanAndReasoningEvents(context, event, currentId, setActivity);
        return;
      }
      if (
        event.method === 'turn/plan/updated' ||
        event.method === 'turn/diff/updated' ||
        event.method === 'item/completed' ||
        event.method === 'thread/status/changed'
      ) {
        processTurnLifecycleEvents(
          context,
          event,
          currentId,
          pendingApprovalId,
          pendingUserInputRequestId,
        );
        return;
      }
      if (event.method.startsWith('bridge/')) {
        if (event.method === 'bridge/connection/state') {
          processBridgeConnectionEvents(context, event, currentId);
          return;
        }
        processBridgeInteractionEvents(
          context,
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
