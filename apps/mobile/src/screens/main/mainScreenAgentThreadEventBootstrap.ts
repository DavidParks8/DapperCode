import { useEffect } from 'react';
import type { RpcNotification } from '../../api/types';
import { parseAgUiEventNotification } from '../../api/agUi';
import { toRecord } from '../../runtimeValidation';
import { EventType } from '@ag-ui/core';
import {
  extractNotificationThreadId,
  extractNotificationParentThreadId,
} from './mainScreenHelpers';
import type {
  MainScreenAgentThreadSelectorStateContext,
  MainScreenAgentThreadSelectorStateResult,
} from './mainScreenAgentThreadSelectorState';

export type MainScreenAgentThreadEventBootstrapContext = MainScreenAgentThreadSelectorStateContext &
  MainScreenAgentThreadSelectorStateResult;

function isAgUiLifecycleEvent(event: RpcNotification): boolean {
  const agUi = parseAgUiEventNotification(event);
  return Boolean(
    agUi &&
    (agUi.event.type === EventType.RUN_STARTED ||
      agUi.event.type === EventType.RUN_FINISHED ||
      agUi.event.type === EventType.RUN_ERROR),
  );
}

function shouldHandleAgentThreadEvent(event: RpcNotification): boolean {
  return (
    event.method === 'thread/started' ||
    event.method === 'thread/name/updated' ||
    event.method === 'thread/status/changed' ||
    isAgUiLifecycleEvent(event)
  );
}

function shouldRefreshAgentThreadList(params: {
  event: RpcNotification;
  currentThreadId: string;
  currentRootThreadId: string;
}): boolean {
  const { event, currentThreadId, currentRootThreadId } = params;
  const agUi = parseAgUiEventNotification(event);
  const paramsRecord = toRecord(event.params);
  const eventThreadId = agUi?.threadId ?? extractNotificationThreadId(paramsRecord);
  const eventParentThreadId = extractNotificationParentThreadId(paramsRecord);

  if (!eventThreadId) {
    return eventParentThreadId === currentThreadId || eventParentThreadId === currentRootThreadId;
  }

  return (
    eventThreadId === currentThreadId ||
    eventThreadId === currentRootThreadId ||
    eventParentThreadId === currentThreadId ||
    eventParentThreadId === currentRootThreadId
  );
}

export function useMainScreenAgentThreadEventBootstrap(
  context: MainScreenAgentThreadEventBootstrapContext,
) {
  const { agentRootThreadIdRef, chatIdRef, scheduleAgentThreadsRefresh, ws } = context;

  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      if (!shouldHandleAgentThreadEvent(event)) {
        return;
      }

      const currentThreadId = chatIdRef.current;
      const currentRootThreadId = agentRootThreadIdRef.current;
      if (!currentThreadId || !currentRootThreadId) {
        return;
      }

      if (!shouldRefreshAgentThreadList({ event, currentThreadId, currentRootThreadId })) {
        return;
      }

      scheduleAgentThreadsRefresh(currentThreadId);
    });
  }, [agentRootThreadIdRef, chatIdRef, scheduleAgentThreadsRefresh, ws]);

  return {};
}

export type MainScreenAgentThreadEventBootstrapResult = ReturnType<
  typeof useMainScreenAgentThreadEventBootstrap
>;
