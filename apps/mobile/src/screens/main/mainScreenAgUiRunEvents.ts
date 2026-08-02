import {
  activeTurnIdAtom,
  errorAtom,
  liveAssistantByThreadAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import { screenSetter } from '../../state/mainScreen/registry';
import {
  activityAtom,
  pendingPlanImplementationPromptsAtom,
} from '../../state/mainScreen/composer';
import { EventType } from '@ag-ui/core';

import {
  type AgUiEventEnvelope,
  parseAgUiEventNotification,
  updateAgUiLiveAssistantMessages,
} from '../../api/agUi';
import type { ChatMessage, RpcNotification } from '../../api/types';
import { type ActivityState, RUN_WATCHDOG_MS } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';

function resolveRunErrorMessage(envelope: AgUiEventEnvelope): string | undefined {
  return envelope.event.type === EventType.RUN_ERROR ? envelope.event.message : undefined;
}

function resolveRunErrorCode(envelope: AgUiEventEnvelope): string {
  return envelope.event.type === EventType.RUN_ERROR ? (envelope.event.code ?? '') : '';
}

export function processAgUiRunEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const {
    scheduleAgentThreadsRefresh,
    schedulePinnedScrollToBottom,
    clearLiveReasoningMessage,
    planItemTurnIdByThreadRef,
    upsertThreadRuntimeSnapshot,
    registerTurnStarted,
    setActiveCommands,
    bumpRunWatchdog,
    cacheThreadTurnState,
    cacheThreadActivity,
    stopRequestedRef,
    threadReasoningBuffersRef,
    bumpAgentRuntimeRevision,
    clearRunWatchdog,
    setStreamingText,
    hadCommandRef,
    reasoningSummaryRef,
    reasoningBufferRef,
    appendStopSystemMessageIfNeeded,
    setSelectedChat,
    clearPendingPlanImplementationPrompt,
    loadChat,
    store,
  } = context;
  const setError = screenSetter(store, errorAtom);
  const setPendingUserInputRequest = screenSetter(store, pendingUserInputRequestAtom);
  const setUserInputDrafts = screenSetter(store, userInputDraftsAtom);
  const setUserInputError = screenSetter(store, userInputErrorAtom);
  const setResolvingUserInput = screenSetter(store, resolvingUserInputAtom);
  const setLiveAssistantByThread = screenSetter(store, liveAssistantByThreadAtom);
  const setActiveTurnId = screenSetter(store, activeTurnIdAtom);
  const setStoppingTurn = screenSetter(store, stoppingTurnAtom);
  const setActivity = screenSetter(store, activityAtom);
  const setPendingPlanImplementationPrompts = screenSetter(
    store,
    pendingPlanImplementationPromptsAtom,
  );

  const agUiEnvelope = parseAgUiEventNotification(event);
  if (!agUiEnvelope) {
    return;
  }

  setLiveAssistantByThread((previous) => updateAgUiLiveAssistantMessages(previous, agUiEnvelope));

  const handlers: Partial<Record<AgUiEventEnvelope['event']['type'], () => void>> = {
    CUSTOM: () => {
      if (!isSubagentCustomEvent(agUiEnvelope)) {
        return;
      }
      scheduleAgentThreadsRefresh(agUiEnvelope.threadId);
      scrollCurrentThreadIntoView(agUiEnvelope);
    },
    TEXT_MESSAGE_CONTENT: () => {
      scrollCurrentThreadIntoView(agUiEnvelope);
    },
    RUN_STARTED: () => {
      const sourceTurnId = agUiEnvelope.sourceTurnId ?? agUiEnvelope.runId;
      clearLiveReasoningMessage(agUiEnvelope.threadId);
      delete planItemTurnIdByThreadRef.current[agUiEnvelope.threadId];
      upsertThreadRuntimeSnapshot(agUiEnvelope.threadId, () => ({
        activeCommands: [],
        streamingText: null,
      }));
      if (agUiEnvelope.threadId === currentId) {
        registerTurnStarted(agUiEnvelope.threadId, sourceTurnId);
        setError(null);
        setActiveTurnId(sourceTurnId);
        setActiveCommands([]);
        setActivity({ tone: 'running', title: 'Working' });
        bumpRunWatchdog();
        return;
      }
      cacheThreadTurnState(agUiEnvelope.threadId, {
        activeTurnId: sourceTurnId,
        runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
      });
      cacheThreadActivity(agUiEnvelope.threadId, {
        tone: 'running',
        title: 'Working',
      });
    },
    RUN_FINISHED: () => {
      handleRunTerminalState(agUiEnvelope, false);
    },
    RUN_ERROR: () => {
      handleRunTerminalState(agUiEnvelope, true);
    },
  };

  function scrollCurrentThreadIntoView(envelope: AgUiEventEnvelope) {
    if (envelope.threadId === currentId) {
      schedulePinnedScrollToBottom(true);
    }
  }

  function handleRunTerminalState(envelope: AgUiEventEnvelope, failed: boolean) {
    const interruptedByUser = isInterruptedRunError(envelope, failed, stopRequestedRef.current);
    const planTurnId = planItemTurnIdByThreadRef.current[envelope.threadId] ?? null;
    delete planItemTurnIdByThreadRef.current[envelope.threadId];
    clearLiveReasoningMessage(envelope.threadId);
    delete threadReasoningBuffersRef.current[envelope.threadId];
    const terminalActivity = buildTerminalActivityState(envelope, failed, interruptedByUser);
    upsertThreadRuntimeSnapshot(envelope.threadId, () => ({
      activity: terminalActivity,
      activeCommands: [],
      streamingText: null,
      pendingUserInputRequest: null,
      activeTurnId: null,
      runWatchdogUntil: 0,
    }));
    bumpAgentRuntimeRevision();
    if (envelope.threadId !== currentId) {
      return;
    }
    clearRunWatchdog();
    setActiveCommands([]);
    setStreamingText(null);
    setPendingUserInputRequest(null);
    setUserInputDrafts({});
    setUserInputError(null);
    setResolvingUserInput(false);
    setActiveTurnId(null);
    setStoppingTurn(false);
    stopRequestedRef.current = false;
    hadCommandRef.current = false;
    reasoningSummaryRef.current = {};
    reasoningBufferRef.current = '';
    setError(failed && !interruptedByUser ? (resolveRunErrorMessage(envelope) ?? null) : null);
    if (interruptedByUser) {
      appendStopSystemMessageIfNeeded();
    }
    setActivity(terminalActivity);
    const terminalStatusAt = new Date().toISOString();
    setSelectedChat((previous) =>
      previous?.id === envelope.threadId
        ? {
            ...previous,
            status: failed && !interruptedByUser ? 'error' : 'complete',
            updatedAt: terminalStatusAt,
            statusUpdatedAt: terminalStatusAt,
            lastError: failed && !interruptedByUser ? resolveRunErrorMessage(envelope) : undefined,
            messages: settlePendingReasoningMessages(previous.messages),
          }
        : previous,
    );
    if (!failed && planTurnId) {
      setPendingPlanImplementationPrompts((previous) => ({
        ...previous,
        [envelope.threadId]: {
          threadId: envelope.threadId,
          turnId: planTurnId,
        },
      }));
    } else {
      clearPendingPlanImplementationPrompt(envelope.threadId);
    }
    loadChat(envelope.threadId).catch(() => {});
  }

  handlers[agUiEnvelope.event.type]?.();
}

/**
 * A run that reached a terminal state can no longer extend its reasoning, so every
 * still-pending reasoning message collapses to its completed presentation.
 */
function settlePendingReasoningMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.role === 'reasoning' && message.pending === true
      ? { ...message, pending: false }
      : message,
  );
}

function isSubagentCustomEvent(envelope: AgUiEventEnvelope): boolean {
  return envelope.event.type === 'CUSTOM' && envelope.event.name === 'dappercode.dev/subagent';
}

function isInterruptedRunError(
  envelope: AgUiEventEnvelope,
  failed: boolean,
  stopRequested: boolean,
): boolean {
  return (
    failed &&
    ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(resolveRunErrorCode(envelope)) &&
    stopRequested
  );
}

function buildTerminalActivityState(
  envelope: AgUiEventEnvelope,
  failed: boolean,
  interruptedByUser: boolean,
): ActivityState {
  if (!failed) {
    return { tone: 'complete', title: 'Turn completed' };
  }
  if (interruptedByUser) {
    return { tone: 'complete', title: 'Turn stopped' };
  }
  return { tone: 'error', title: 'Turn failed', detail: resolveRunErrorMessage(envelope) };
}
