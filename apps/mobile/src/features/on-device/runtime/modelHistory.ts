import type { LocalMessage, LocalThread } from './types';

export function emptyLocalAnswer(message: LocalMessage): boolean {
  return message.role === 'assistant' && !message.content.trim() && !message.toolCalls?.length;
}

/**
 * Keeps recorded tool activity when retrying, but regenerates answer-only attempts after it.
 * Tools from the previous attempt are never replayed.
 */
export function retryableLocalMessages(thread: LocalThread): LocalMessage[] | null {
  if (thread.status !== 'failed' && thread.status !== 'interrupted') {
    return null;
  }
  let lastUser = -1;
  thread.messages.forEach((message, index) => {
    if (message.role === 'user') {
      lastUser = index;
    }
  });
  if (lastUser < 0) {
    return null;
  }
  const turn = thread.messages.slice(lastUser + 1);
  let lastToolActivity = -1;
  turn.forEach((message, index) => {
    if (message.role === 'tool' || message.toolCalls?.length) {
      lastToolActivity = index;
    }
  });
  return [
    ...thread.messages.slice(0, lastUser + 1),
    ...turn.slice(0, lastToolActivity + 1).filter((message) => !emptyLocalAnswer(message)),
  ];
}
