import { EventType } from '@ag-ui/core';
import type { ChatMessage, ChatToolMeta } from '@bridge/types/types';

export interface AgUiChunkAssembly {
  count: number;
  chunks: Record<number, string>;
}

export interface AgUiThreadMessageState {
  messages: ChatMessage[];
  messageIndexById: Record<string, number>;
  authoritativeSnapshot: boolean;
  runByMessageId: Record<string, string>;
  terminalMessageIds: string[];
  replacesMessageIdByMessageId: Record<string, string>;
  toolCallMessageIdByCallId: Record<string, string>;
  toolResultMessageIdByCallId: Record<string, string>;
  subagentToolCallIds: Record<string, true>;
  toolMetaByCallId: Record<string, ChatToolMeta>;
  toolTextRevisionByCallId: Record<string, string>;
  structuredRevisionByCallId: Record<string, string>;
  structuredTextByCallId: Record<string, string>;
  chunkAssemblies: Record<string, AgUiChunkAssembly>;
  state: unknown;
  steps: Record<string, 'running' | 'finished'>;
  rawEvents: unknown[];
  customMetadata: Record<string, unknown>;
  customMetadataOrder: string[];
}

export type AgUiMessageState = Record<string, AgUiThreadMessageState>;

export const MAX_MESSAGES_PER_THREAD = 128;
export const MAX_RAW_EVENTS_PER_THREAD = 128;
export const MAX_CUSTOM_METADATA_ENTRIES = 128;

export const SUPPORTED_AG_UI_EVENT_TYPES = new Set<EventType>([
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_CHUNK,
  EventType.TOOL_CALL_RESULT,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.MESSAGES_SNAPSHOT,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.ACTIVITY_DELTA,
  EventType.RAW,
  EventType.CUSTOM,
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
]);

export function createAgUiThreadMessageState(): AgUiThreadMessageState {
  return {
    messages: [],
    messageIndexById: {},
    authoritativeSnapshot: false,
    runByMessageId: {},
    terminalMessageIds: [],
    replacesMessageIdByMessageId: {},
    toolCallMessageIdByCallId: {},
    toolResultMessageIdByCallId: {},
    subagentToolCallIds: {},
    toolMetaByCallId: {},
    toolTextRevisionByCallId: {},
    structuredRevisionByCallId: {},
    structuredTextByCallId: {},
    chunkAssemblies: {},
    state: null,
    steps: {},
    rawEvents: [],
    customMetadata: {},
    customMetadataOrder: [],
  };
}

export function findMessageIndex(current: AgUiThreadMessageState, id: string): number {
  const indexed = current.messageIndexById[id];
  if (indexed !== undefined && current.messages[indexed]?.id === id) {
    return indexed;
  }
  return current.messages.findIndex((message) => message.id === id);
}

export function indexMessages(messages: readonly ChatMessage[]): Record<string, number> {
  return Object.fromEntries(messages.map((message, index) => [message.id, index]));
}
