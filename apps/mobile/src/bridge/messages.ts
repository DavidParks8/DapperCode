import type { ActivityMessage, Message } from '@ag-ui/core';

import type {
  ChatAgentMessageMeta,
  ChatMessage,
  ChatMessageSubAgentMeta,
} from '@bridge/types/types';

export const SUBAGENT_ACTIVITY_TYPE = 'dappercode.subagent';
export const COMPACTION_ACTIVITY_TYPE = 'dappercode.compaction';
export const AGENT_MESSAGE_ACTIVITY_TYPE = 'dappercode.agent_message';

export interface DapperCodeActivityContent extends Record<string, unknown> {
  text: string;
  subAgent?: ChatMessageSubAgentMeta;
  agentMessage?: ChatAgentMessageMeta;
}

function readActivityText(content: unknown): string {
  return content &&
    typeof content === 'object' &&
    'text' in content &&
    typeof content.text === 'string'
    ? content.text
    : '';
}

function readUserText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: unknown[] = content;
  let text = '';
  for (const part of parts) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      text += part.text;
    }
  }
  return text;
}

export function getMessageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('role' in message) || !('content' in message)) {
    return '';
  }
  if (message.role === 'activity') {
    return readActivityText(message.content);
  }
  if (message.role === 'user') {
    return readUserText(message.content);
  }
  return typeof message.content === 'string' ? message.content : '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isOptionalStringProperty(value: Record<string, unknown>, key: string): boolean {
  const property = value[key];
  return property === undefined || typeof property === 'string';
}

function isOptionalStringArrayProperty(value: Record<string, unknown>, key: string): boolean {
  const property = value[key];
  return property === undefined || isStringArray(property);
}

function isChatMessageSubAgentMeta(value: unknown): value is ChatMessageSubAgentMeta {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOptionalStringProperty(value, 'toolCallId') &&
    isOptionalStringProperty(value, 'tool') &&
    isOptionalStringProperty(value, 'prompt') &&
    isOptionalStringProperty(value, 'senderThreadId') &&
    isOptionalStringArrayProperty(value, 'receiverThreadIds') &&
    isOptionalStringProperty(value, 'agentStatus')
  );
}

function isChatAgentMessageMeta(value: unknown): value is ChatAgentMessageMeta {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['messageId'] === 'string' &&
    (value['direction'] === 'sent' || value['direction'] === 'received') &&
    typeof value['relatedThreadId'] === 'string' &&
    (value['relatedTitle'] === undefined ||
      value['relatedTitle'] === null ||
      typeof value['relatedTitle'] === 'string') &&
    (value['relation'] === 'parent' || value['relation'] === 'sub_agent') &&
    (value['disposition'] === 'sent' ||
      value['disposition'] === 'steering' ||
      value['disposition'] === 'queued') &&
    typeof value['body'] === 'string'
  );
}

export function parseAgentMessageMeta(value: unknown): ChatAgentMessageMeta | undefined {
  return isChatAgentMessageMeta(value) ? value : undefined;
}

export function getAgentMessageMeta(
  message: Message | ChatMessage,
): ChatAgentMessageMeta | undefined {
  if (message.role !== 'activity' || message.activityType !== AGENT_MESSAGE_ACTIVITY_TYPE) {
    return undefined;
  }
  const value: unknown = message.content.agentMessage;
  return parseAgentMessageMeta(value);
}

export function getSubAgentMeta(
  message: Message | ChatMessage,
): ChatMessageSubAgentMeta | undefined {
  if (message.role !== 'activity' || message.activityType !== SUBAGENT_ACTIVITY_TYPE) {
    return undefined;
  }
  const value: unknown = message.content.subAgent;
  return isChatMessageSubAgentMeta(value) ? value : undefined;
}

export function getSubAgentThreadId(message: Message | ChatMessage): string | undefined {
  return getSubAgentMeta(message)
    ?.receiverThreadIds?.map((id) => id.trim())
    .find(Boolean);
}

export function isUnlinkedSubAgentActivity(message: Message | ChatMessage): boolean {
  return (
    message.role === 'activity' &&
    message.activityType === SUBAGENT_ACTIVITY_TYPE &&
    getSubAgentThreadId(message) === undefined
  );
}

export function preserveKnownSubAgentThreadLink(
  existing: ChatMessage | undefined,
  incoming: ChatMessage,
): ChatMessage {
  if (incoming.role !== 'activity' || incoming.activityType !== SUBAGENT_ACTIVITY_TYPE) {
    return incoming;
  }
  const existingMeta = existing ? getSubAgentMeta(existing) : undefined;
  const existingIds = (existingMeta?.receiverThreadIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  if (existingIds.length === 0) {
    return incoming;
  }
  const incomingMeta = getSubAgentMeta(incoming);
  const incomingIds = (incomingMeta?.receiverThreadIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    incomingIds.length > 0 ||
    (existingMeta?.toolCallId &&
      incomingMeta?.toolCallId &&
      existingMeta.toolCallId !== incomingMeta.toolCallId)
  ) {
    return incoming;
  }
  return {
    ...incoming,
    content: {
      ...incoming.content,
      subAgent: {
        ...existingMeta,
        ...incomingMeta,
        receiverThreadIds: existingIds,
      },
    },
  };
}

export function getToolCallDisplayLines(message: Message | ChatMessage): string[] {
  if (message.role !== 'assistant' || !message.toolCalls?.length) {
    return [];
  }
  return message.toolCalls.map((call) => {
    const args = call.function.arguments.trim();
    return [`• Called tool \`${call.function.name}\``, args && args !== '{}' ? `  ${args}` : null]
      .filter(Boolean)
      .join('\n');
  });
}

export function createActivityMessage(
  id: string,
  activityType: string,
  content: DapperCodeActivityContent,
  createdAt: string,
): ChatMessage {
  return {
    id,
    role: 'activity',
    activityType,
    content,
    createdAt,
  } satisfies ActivityMessage & { createdAt: string };
}
