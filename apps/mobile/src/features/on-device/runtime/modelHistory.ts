import type { LocalModelMessage } from '../models/engine';
import type { LocalMessage, LocalThread } from './types';

export { localConversationTitle } from './agentPolicy';

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

export function localModelHistory(
  messages: readonly LocalMessage[],
  pendingAssistantId: string,
): LocalModelMessage[] {
  const userIndex = messages.map((message) => message.role).lastIndexOf('user');
  const priorTools = messages.slice(0, userIndex).some((entry) => entry.role === 'tool');
  const history = messages.filter(
    (message) => message.id !== pendingAssistantId && !emptyLocalAnswer(message),
  );
  const projected = history.map((message): LocalModelMessage => ({
    role: message.role,
    content:
      priorTools && message === messages[userIndex]
        ? `[Current request. Earlier workspace observations are historical snapshots; read files again when current contents are requested.]\n\n${message.content}`
        : message.content,
    ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
    ...(message.tool ? { name: message.tool.name, tool_call_id: message.tool.callId } : {}),
  }));
  // Tool-response templates need a new assistant boundary before decoding the next round.
  return projected.at(-1)?.role === 'tool'
    ? [...projected, { role: 'assistant', content: '' }]
    : projected;
}
