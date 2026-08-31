import type { ChatMessage } from '@bridge/types/types';

export function resolveMessageTimestamp(message: ChatMessage): string | null {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }
  if (
    message.role === 'assistant' &&
    (message.pending === true || (message.toolCalls?.length ?? 0) > 0)
  ) {
    return null;
  }

  const timestamp =
    message.role === 'assistant' ? (message.completedAt ?? message.createdAt) : message.createdAt;
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

export function formatMessageTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}
