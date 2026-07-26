import type { ActivityMessage, Message } from '@ag-ui/core';

import type { ChatMessage, ChatMessageSubAgentMeta } from './types';

export const SUBAGENT_ACTIVITY_TYPE = 'dappercode.subagent';
export const COMPACTION_ACTIVITY_TYPE = 'dappercode.compaction';

export interface DapperCodeActivityContent extends Record<string, unknown> {
  text: string;
  subAgent?: ChatMessageSubAgentMeta;
}

export function getMessageText(message: Message | ChatMessage): string {
  if (message.role === 'activity') {
    return typeof message.content.text === 'string' ? message.content.text : '';
  }
  if (message.role === 'assistant') {
    return message.content ?? '';
  }
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return message.content;
    }
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }
  return message.content;
}

export function getSubAgentMeta(
  message: Message | ChatMessage,
): ChatMessageSubAgentMeta | undefined {
  if (message.role !== 'activity' || message.activityType !== SUBAGENT_ACTIVITY_TYPE) {
    return undefined;
  }
  const value = message.content.subAgent;
  return value && typeof value === 'object' ? (value as ChatMessageSubAgentMeta) : undefined;
}

export function getToolCallDisplayLines(message: Message | ChatMessage): string[] {
  if (message.role !== 'assistant' || !message.toolCalls?.length) return [];
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
