import {
  activeBridgeUiSurfacesAtom,
  activePlanAtom,
  activeTurnIdAtom,
  liveAssistantByThreadAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
} from '../state/turn';
import { selectedCollaborationModeAtom } from '../state/models';
import { screenSetter } from '../state/registry';
import { startNewChatAtom } from '@shell/navigation/actions';
import { activityAtom } from '../state/composer';
import type { RpcNotification } from '@bridge/types/types';
import {
  lookupDispatchEntry,
  readFiniteNumber,
  readString,
  toRecord,
} from '@shared/runtimeValidation';
import {
  RUN_WATCHDOG_MS,
  describeStartedToolEvent,
  extractNotificationThreadId,
} from '../helpers/helpers';
import type { MainScreenWsEventRouterContext } from './wsEventRouter';

type ThreadStateEventMethod =
  | 'bridge/events/snapshotRequired'
  | 'thread/name/updated'
  | 'thread/deleted'
  | 'thread/tokenUsage/updated'
  | 'item/started';

const THREAD_STATE_RUNNING_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'reasoning',
]);

const CURRENT_THREAD_STATE_RUNNING_ITEM_TYPES = new Set([
  ...THREAD_STATE_RUNNING_ITEM_TYPES,
  'toolCall',
]);

export function processThreadStateEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const handler = lookupDispatchEntry(THREAD_STATE_EVENT_HANDLERS, event.method);
  if (!handler) {
    return;
  }

  handler(createThreadStateEventContext(context), event, currentId);
}

type ThreadStateEventContext = ReturnType<typeof createThreadStateEventContext>;
type ThreadStateEventHandler = (
  context: ThreadStateEventContext,
  event: RpcNotification,
  currentId: string | null,
) => void;

const THREAD_STATE_EVENT_HANDLERS: Record<ThreadStateEventMethod, ThreadStateEventHandler> = {
  'bridge/events/snapshotRequired': handleSnapshotRequiredEvent,
  'thread/name/updated': handleThreadNameUpdatedEvent,
  'thread/deleted': handleThreadDeletedEvent,
  'thread/tokenUsage/updated': handleThreadTokenUsageUpdatedEvent,
  'item/started': handleItemStartedEvent,
};

function createThreadStateEventContext(context: MainScreenWsEventRouterContext) {
  const { store } = context;
  return {
    ...context,
    setPendingApproval: screenSetter(store, pendingApprovalAtom),
    setPendingUserInputRequest: screenSetter(store, pendingUserInputRequestAtom),
    setActivePlan: screenSetter(store, activePlanAtom),
    setActiveBridgeUiSurfaces: screenSetter(store, activeBridgeUiSurfacesAtom),
    setLiveAssistantByThread: screenSetter(store, liveAssistantByThreadAtom),
    setActiveTurnId: screenSetter(store, activeTurnIdAtom),
    setSelectedCollaborationMode: screenSetter(store, selectedCollaborationModeAtom),
    setActivity: screenSetter(store, activityAtom),
  };
}

function handleSnapshotRequiredEvent(
  context: ThreadStateEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const params = toRecord(event.params);
  const resumeAfterEventId = readFiniteNumber(params?.['resumeAfterEventId']);
  const reason = readString(params?.['reason']);
  context.clearRunWatchdog();
  context.setStreamingText(null);
  context.setLiveAssistantByThread({});
  context.setActiveTurnId(null);
  context.setPendingApproval(null);
  context.setPendingUserInputRequest(null);
  context.setActivePlan(null);
  context.setActiveBridgeUiSurfaces([]);
  if (currentId) {
    context.replaceThreadBridgeUiSurfaces(currentId, []);
  }
  context.reasoningSummaryRef.current = {};
  context.reasoningBufferRef.current = '';
  context.recoverReplayGap(resumeAfterEventId, reason !== 'recoveryOverflow');
  if (context.agentDetailThreadId) {
    context.scheduleAgentThreadsRefresh(context.agentDetailThreadId);
  }
}

function handleThreadNameUpdatedEvent(
  context: ThreadStateEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const params = toRecord(event.params);
  const threadId = extractNotificationThreadId(params);
  if (!threadId || threadId !== currentId) {
    return;
  }

  const threadName = readString(params?.['threadName']) ?? readString(params?.['thread_name']);
  if (threadName && threadName.trim()) {
    context.setSelectedChat((prev) =>
      prev
        ? {
            ...prev,
            title: threadName,
          }
        : prev,
    );
    return;
  }

  context.loadChat(threadId, { preserveRuntimeState: true }).catch(() => {});
}

function handleThreadDeletedEvent(
  context: ThreadStateEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const params = toRecord(event.params);
  const threadId = extractNotificationThreadId(params);
  if (!threadId || threadId !== currentId) {
    return;
  }

  // The thread is gone on the agent, so keeping it open would only surface stale history.
  context.store.set(startNewChatAtom);
}

function handleThreadTokenUsageUpdatedEvent(
  context: ThreadStateEventContext,
  event: RpcNotification,
): void {
  const params = toRecord(event.params);
  const threadId = readString(params?.['threadId']) ?? readString(params?.['thread_id']);
  const contextUsage = context.readThreadContextUsage(params);
  if (!threadId || !contextUsage) {
    return;
  }

  context.cacheThreadContextUsage(threadId, contextUsage);
}

function handleItemStartedEvent(
  context: ThreadStateEventContext,
  event: RpcNotification,
  currentId: string | null,
): void {
  const params = toRecord(event.params);
  const threadId = readString(params?.['threadId']) ?? readString(params?.['thread_id']);
  if (!threadId) {
    return;
  }

  const item = toRecord(params?.['item']);
  const itemType = readString(item?.['type']);
  const itemTurnId = readString(params?.['turnId']) ?? readString(params?.['turn_id']) ?? null;
  if (itemType === 'plan' && itemTurnId) {
    context.planItemTurnIdByThreadRef.current[threadId] = itemTurnId;
  }

  if (threadId !== currentId) {
    handleNonCurrentItemStarted(context, threadId, item, itemType);
    return;
  }

  handleCurrentItemStarted(context, threadId, item, itemType);
}

function handleNonCurrentItemStarted(
  context: ThreadStateEventContext,
  threadId: string,
  item: Record<string, unknown> | null,
  itemType: string | null,
): void {
  context.cacheThreadTurnState(threadId, {
    runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
  });
  const startedToolEvent = describeStartedToolEvent(item);
  if (startedToolEvent) {
    context.cacheThreadActiveCommand(threadId, startedToolEvent.eventType, startedToolEvent.detail);
  }

  const activityTitle = getThreadStateItemActivityTitle(itemType, false);
  if (!activityTitle) {
    return;
  }

  context.cacheThreadActivity(threadId, {
    tone: 'running',
    title: activityTitle,
  });
}

function handleCurrentItemStarted(
  context: ThreadStateEventContext,
  threadId: string,
  item: Record<string, unknown> | null,
  itemType: string | null,
): void {
  context.bumpRunWatchdog();
  const startedToolEvent = describeStartedToolEvent(item);
  if (startedToolEvent) {
    context.cacheThreadActiveCommand(threadId, startedToolEvent.eventType, startedToolEvent.detail);
  }

  if (itemType === 'plan') {
    context.setSelectedCollaborationMode('plan');
    context.setActivity({
      tone: 'running',
      title: 'Planning',
    });
    return;
  }

  if (itemType === 'reasoning') {
    context.upsertLiveReasoningMessage(threadId);
  }

  if (!getThreadStateItemActivityTitle(itemType, true)) {
    return;
  }

  context.setActivity({
    tone: 'running',
    title: 'Working',
  });
}

function getThreadStateItemActivityTitle(
  itemType: string | null,
  isCurrentThread: boolean,
): 'Working' | 'Planning' | null {
  if (itemType === 'plan') {
    return 'Planning';
  }

  const supportedTypes = isCurrentThread
    ? CURRENT_THREAD_STATE_RUNNING_ITEM_TYPES
    : THREAD_STATE_RUNNING_ITEM_TYPES;
  return itemType && supportedTypes.has(itemType) ? 'Working' : null;
}
