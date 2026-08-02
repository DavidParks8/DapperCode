import { EventType } from '@ag-ui/core';
import {
  appendText,
  appendToolResult,
  reduceActivitySnapshot,
  rememberReplacement,
  startToolCall,
  textMessage,
  upsertMessage,
} from './agUiMessageMutations';
import {
  appendToolArgs,
  applyActivityDelta,
  applyMessagesSnapshot,
  reduceCustomEvent,
} from './agUiToolAndCustomEventReducers';
import { applyJsonPatch, nonEmptyString, record, timestampIso } from './agUiReducerUtilities';
import {
  findMessage,
  markRunTerminal,
  markTerminal,
  updateEncryptedValue,
} from './agUiStructuredAndTerminalReducers';
import { type AgUiEventEnvelope } from './agUi';
import {
  type AgUiThreadMessageState,
  createAgUiThreadMessageState,
  MAX_RAW_EVENTS_PER_THREAD,
} from './agUiMessagesState';

type ThreadEventHandler = (
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
) => AgUiThreadMessageState;

function reduceTextMessageStartEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TEXT_MESSAGE_START) return current;
  const event = envelope.event;
  const started = findMessage(current, event.messageId)
    ? current
    : upsertMessage(
        current,
        textMessage(event.messageId, event.role, '', event.name),
        envelope.runId,
        event.timestamp,
      );
  return rememberReplacement(
    started,
    event.messageId,
    nonEmptyString(record(event)?.replacesMessageId),
  );
}

function reduceTextMessageContentEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TEXT_MESSAGE_CONTENT) return current;
  const event = envelope.event;
  return appendText(
    current,
    event.messageId,
    event.delta,
    envelope.runId,
    event.timestamp,
    'assistant',
  );
}

function reduceTextMessageEndEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TEXT_MESSAGE_END) return current;
  return markTerminal(current, envelope.event.messageId);
}

function reduceTextMessageChunkEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TEXT_MESSAGE_CHUNK) return current;
  const event = envelope.event;
  const messageId = event.messageId ?? `${envelope.runId}:text`;
  let next = current;
  if (!findMessage(next, messageId)) {
    next = upsertMessage(
      next,
      textMessage(messageId, event.role ?? 'assistant', '', event.name),
      envelope.runId,
      event.timestamp,
    );
  }
  return event.delta
    ? appendText(
        next,
        messageId,
        event.delta,
        envelope.runId,
        event.timestamp,
        event.role ?? 'assistant',
      )
    : next;
}

function reduceReasoningStartEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  const event = envelope.event;
  if (
    event.type !== EventType.REASONING_START &&
    event.type !== EventType.REASONING_MESSAGE_START
  ) {
    return current;
  }
  return findMessage(current, event.messageId)
    ? current
    : upsertMessage(
        current,
        {
          id: event.messageId,
          role: 'reasoning',
          content: '',
          createdAt: timestampIso(event.timestamp),
        },
        envelope.runId,
        event.timestamp,
      );
}

function reduceReasoningContentEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.REASONING_MESSAGE_CONTENT) return current;
  const event = envelope.event;
  return appendText(
    current,
    event.messageId,
    event.delta,
    envelope.runId,
    event.timestamp,
    'reasoning',
  );
}

function reduceReasoningChunkEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.REASONING_MESSAGE_CHUNK) return current;
  const event = envelope.event;
  const messageId = event.messageId ?? `${envelope.runId}:reasoning`;
  const next = findMessage(current, messageId)
    ? current
    : upsertMessage(
        current,
        {
          id: messageId,
          role: 'reasoning',
          content: '',
          createdAt: timestampIso(event.timestamp),
        },
        envelope.runId,
        event.timestamp,
      );
  return event.delta
    ? appendText(next, messageId, event.delta, envelope.runId, event.timestamp, 'reasoning')
    : next;
}

function reduceReasoningEndEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  const event = envelope.event;
  if (event.type !== EventType.REASONING_MESSAGE_END && event.type !== EventType.REASONING_END) {
    return current;
  }
  return markTerminal(current, event.messageId);
}

function reduceReasoningEncryptedValueEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.REASONING_ENCRYPTED_VALUE) return current;
  const event = envelope.event;
  return updateEncryptedValue(current, event.entityId, event.encryptedValue, event.subtype);
}

function reduceToolCallStartEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TOOL_CALL_START) return current;
  const event = envelope.event;
  if (current.subagentToolCallIds[event.toolCallId]) return current;
  return startToolCall(
    current,
    envelope.runId,
    event.toolCallId,
    event.toolCallName,
    event.parentMessageId,
    event.timestamp,
  );
}

function reduceToolCallArgsEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TOOL_CALL_ARGS) return current;
  const event = envelope.event;
  if (current.subagentToolCallIds[event.toolCallId]) return current;
  return appendToolArgs(current, envelope.runId, event.toolCallId, event.delta, event.timestamp);
}

function reduceToolCallEndEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TOOL_CALL_END) return current;
  const event = envelope.event;
  if (current.subagentToolCallIds[event.toolCallId]) return current;
  const messageId = current.toolCallMessageIdByCallId[event.toolCallId];
  return messageId ? markTerminal(current, messageId) : current;
}

function reduceToolCallChunkEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TOOL_CALL_CHUNK) return current;
  const event = envelope.event;
  if (!event.toolCallId) return current;
  if (current.subagentToolCallIds[event.toolCallId]) return current;
  let next = current;
  if (!current.toolCallMessageIdByCallId[event.toolCallId]) {
    next = startToolCall(
      next,
      envelope.runId,
      event.toolCallId,
      event.toolCallName ?? 'tool',
      event.parentMessageId,
      event.timestamp,
    );
  }
  return event.delta
    ? appendToolArgs(next, envelope.runId, event.toolCallId, event.delta, event.timestamp)
    : next;
}

function reduceToolCallResultEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.TOOL_CALL_RESULT) return current;
  const event = envelope.event;
  if (current.subagentToolCallIds[event.toolCallId]) return current;
  return appendToolResult(
    current,
    envelope.runId,
    event.messageId,
    event.toolCallId,
    event.content,
    event.timestamp,
  );
}

function reduceMessagesSnapshotEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.MESSAGES_SNAPSHOT) return current;
  const event = envelope.event;
  return applyMessagesSnapshot(current, envelope.runId, event.messages, event.timestamp);
}

function reduceActivitySnapshotEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.ACTIVITY_SNAPSHOT) return current;
  const event = envelope.event;
  return reduceActivitySnapshot(
    current,
    envelope.runId,
    event.messageId,
    event.activityType,
    event.content,
    event.timestamp,
  );
}

function reduceActivityDeltaEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.ACTIVITY_DELTA) return current;
  const event = envelope.event;
  return applyActivityDelta(
    current,
    envelope.runId,
    event.messageId,
    event.activityType,
    event.patch,
    event.timestamp,
  );
}

function reduceStateSnapshotEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.STATE_SNAPSHOT) return current;
  return { ...current, state: envelope.event.snapshot };
}

function reduceStateDeltaEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.STATE_DELTA) return current;
  return { ...current, state: applyJsonPatch(current.state, envelope.event.delta) };
}

function reduceStepStartedEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.STEP_STARTED) return current;
  return { ...current, steps: { ...current.steps, [envelope.event.stepName]: 'running' } };
}

function reduceStepFinishedEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.STEP_FINISHED) return current;
  return { ...current, steps: { ...current.steps, [envelope.event.stepName]: 'finished' } };
}

function reduceRawEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.RAW) return current;
  const event = envelope.event;
  return {
    ...current,
    rawEvents: [...current.rawEvents, { source: event.source, event: event.event }].slice(
      -MAX_RAW_EVENTS_PER_THREAD,
    ),
  };
}

const THREAD_EVENT_HANDLERS: Partial<Record<EventType, ThreadEventHandler>> = {
  [EventType.RUN_STARTED]: () => createAgUiThreadMessageState(),
  [EventType.TEXT_MESSAGE_START]: reduceTextMessageStartEvent,
  [EventType.TEXT_MESSAGE_CONTENT]: reduceTextMessageContentEvent,
  [EventType.TEXT_MESSAGE_END]: reduceTextMessageEndEvent,
  [EventType.TEXT_MESSAGE_CHUNK]: reduceTextMessageChunkEvent,
  [EventType.REASONING_START]: reduceReasoningStartEvent,
  [EventType.REASONING_MESSAGE_START]: reduceReasoningStartEvent,
  [EventType.REASONING_MESSAGE_CONTENT]: reduceReasoningContentEvent,
  [EventType.REASONING_MESSAGE_CHUNK]: reduceReasoningChunkEvent,
  [EventType.REASONING_MESSAGE_END]: reduceReasoningEndEvent,
  [EventType.REASONING_END]: reduceReasoningEndEvent,
  [EventType.REASONING_ENCRYPTED_VALUE]: reduceReasoningEncryptedValueEvent,
  [EventType.TOOL_CALL_START]: reduceToolCallStartEvent,
  [EventType.TOOL_CALL_ARGS]: reduceToolCallArgsEvent,
  [EventType.TOOL_CALL_END]: reduceToolCallEndEvent,
  [EventType.TOOL_CALL_CHUNK]: reduceToolCallChunkEvent,
  [EventType.TOOL_CALL_RESULT]: reduceToolCallResultEvent,
  [EventType.MESSAGES_SNAPSHOT]: reduceMessagesSnapshotEvent,
  [EventType.ACTIVITY_SNAPSHOT]: reduceActivitySnapshotEvent,
  [EventType.ACTIVITY_DELTA]: reduceActivityDeltaEvent,
  [EventType.STATE_SNAPSHOT]: reduceStateSnapshotEvent,
  [EventType.STATE_DELTA]: reduceStateDeltaEvent,
  [EventType.STEP_STARTED]: reduceStepStartedEvent,
  [EventType.STEP_FINISHED]: reduceStepFinishedEvent,
  [EventType.RAW]: reduceRawEvent,
  [EventType.CUSTOM]: reduceCustomEvent,
  [EventType.RUN_FINISHED]: (current, envelope) => markRunTerminal(current, envelope.runId),
  [EventType.RUN_ERROR]: (current, envelope) => markRunTerminal(current, envelope.runId),
};

export function reduceThreadState(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  const handler = THREAD_EVENT_HANDLERS[envelope.event.type];
  return handler ? handler(current, envelope) : current;
}
