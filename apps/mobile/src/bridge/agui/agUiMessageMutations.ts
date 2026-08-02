import {
  appendOrderedPart,
  nonEmptyString,
  record,
  renderOrderedParts,
  timestampIso,
  upsertToolCall,
} from '@bridge/agui/agUiReducerUtilities';
import { createActivityMessage, getMessageText, SUBAGENT_ACTIVITY_TYPE } from '@bridge/messages';
import { findMessage, toolCall } from '@bridge/agui/agUiStructuredAndTerminalReducers';
import {
  findMessageIndex,
  indexMessages,
  type AgUiThreadMessageState,
  MAX_MESSAGES_PER_THREAD,
} from '@bridge/agui/agUiMessagesState';
import type { AssistantMessage } from '@ag-ui/core';
import type { ChatMessage } from '@bridge/types/types';
import { upsertToolResult } from '@bridge/agui/agUiToolAndCustomEventReducers';

export function rememberReplacement(
  current: AgUiThreadMessageState,
  messageId: string,
  replacesMessageId: string | null,
): AgUiThreadMessageState {
  if (!replacesMessageId) {
    return current;
  }
  return {
    ...current,
    replacesMessageIdByMessageId: {
      ...current.replacesMessageIdByMessageId,
      [messageId]: replacesMessageId,
    },
  };
}

export function textMessage(
  id: string,
  role: 'developer' | 'system' | 'assistant' | 'user',
  content: string,
  name?: string,
): ChatMessage {
  const base = {
    id,
    content,
    createdAt: new Date().toISOString(),
    ...(name ? { name } : {}),
  };
  switch (role) {
    case 'developer':
      return { ...base, role: 'developer' };
    case 'system':
      return { ...base, role: 'system' };
    case 'user':
      return { ...base, role: 'user' };
    case 'assistant':
    default:
      return { ...base, role: 'assistant' };
  }
}

export function upsertMessage(
  current: AgUiThreadMessageState,
  message: ChatMessage,
  runId: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const index = findMessageIndex(current, message.id);
  const existing = index >= 0 ? current.messages[index] : undefined;
  const nextMessage: ChatMessage = {
    ...message,
    createdAt: existing?.createdAt ?? timestampIso(timestamp),
  };
  const messages = current.messages.slice();
  if (index >= 0) {
    messages[index] = nextMessage;
  } else {
    messages.push(nextMessage);
  }
  const kept = messages.slice(-MAX_MESSAGES_PER_THREAD);
  const runByMessageId = { ...current.runByMessageId, [message.id]: runId };
  if (kept.length === messages.length) {
    return {
      ...current,
      messages: kept,
      messageIndexById:
        index >= 0 && current.messageIndexById[message.id] === index
          ? current.messageIndexById
          : { ...current.messageIndexById, [message.id]: index >= 0 ? index : kept.length - 1 },
      runByMessageId,
    };
  }
  // Trimming the head must also forget the bookkeeping for the dropped
  // messages, otherwise later events resurrect them at the end of the
  // transcript or attach tool results to messages that no longer exist.
  const dropped = new Set(
    messages.slice(0, messages.length - kept.length).map((entry) => entry.id),
  );
  return {
    ...current,
    messages: kept,
    messageIndexById: indexMessages(kept),
    runByMessageId: withoutMessageIds(runByMessageId, dropped),
    replacesMessageIdByMessageId: withoutMessageIds(current.replacesMessageIdByMessageId, dropped),
    toolCallMessageIdByCallId: withoutMessageValues(current.toolCallMessageIdByCallId, dropped),
    toolResultMessageIdByCallId: withoutMessageValues(current.toolResultMessageIdByCallId, dropped),
    terminalMessageIds: current.terminalMessageIds.filter((id) => !dropped.has(id)),
  };
}

function withoutMessageIds(
  entries: Record<string, string>,
  dropped: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).filter(([id]) => !dropped.has(id)));
}

function withoutMessageValues(
  entries: Record<string, string>,
  dropped: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, messageId]) => !dropped.has(messageId)),
  );
}

export function appendText(
  current: AgUiThreadMessageState,
  messageId: string,
  delta: string,
  runId: string,
  timestamp: number | undefined,
  defaultRole: 'developer' | 'system' | 'assistant' | 'user' | 'reasoning',
): AgUiThreadMessageState {
  const existing = findMessage(current, messageId);
  if (defaultRole !== 'reasoning' && existing?.role !== 'reasoning') {
    const existingParts = existing?.parts ?? [];
    const onlyTextParts = existingParts.every((part) => part.type === 'text');
    const appendedContent = `${existing ? getMessageText(existing) : ''}${delta}`;
    const parts = onlyTextParts
      ? [{ type: 'text' as const, text: appendedContent }]
      : appendOrderedPart(existingParts, { type: 'text', text: delta });
    const content = onlyTextParts ? appendedContent : renderOrderedParts(parts);
    const message = existing
      ? ({ ...withText(existing, content), parts } as ChatMessage)
      : ({
          ...textMessage(messageId, defaultRole, content),
          parts,
        } as ChatMessage);
    return upsertMessage(current, message, runId, timestamp);
  }
  const content = `${existing ? getMessageText(existing) : ''}${delta}`;
  if (existing) {
    return upsertMessage(
      current,
      {
        ...withText(existing, content),
        ...(existing.role === 'reasoning' ? { pending: true } : {}),
      },
      runId,
      timestamp,
    );
  }
  if (defaultRole === 'reasoning') {
    return upsertMessage(
      current,
      {
        id: messageId,
        role: 'reasoning',
        content,
        createdAt: timestampIso(timestamp),
        pending: true,
      },
      runId,
      timestamp,
    );
  }
  return upsertMessage(current, textMessage(messageId, defaultRole, content), runId, timestamp);
}

export function appendToolResult(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  toolCallId: string,
  delta: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const previousId = current.toolResultMessageIdByCallId[toolCallId];
  const previous = previousId ? findMessage(current, previousId) : undefined;
  const previousText = previous?.role === 'tool' ? previous.content : '';
  const withoutPrevious =
    previousId && previousId !== messageId
      ? (() => {
          const messages = current.messages.filter((message) => message.id !== previousId);
          return {
            ...current,
            messages,
            messageIndexById: indexMessages(messages),
          };
        })()
      : current;
  return upsertToolResult(
    withoutPrevious,
    runId,
    messageId,
    toolCallId,
    `${previousText}${delta}`,
    timestamp,
  );
}

export function reduceActivitySnapshot(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  activityType: string,
  content: Record<string, unknown>,
  timestamp?: number,
): AgUiThreadMessageState {
  const subAgent = activityType === SUBAGENT_ACTIVITY_TYPE ? record(content['subAgent']) : null;
  const toolCallId = nonEmptyString(subAgent?.['toolCallId']);
  const withoutGenericTool = toolCallId
    ? (() => {
        const messages = current.messages.filter(
          (message) =>
            message.id !== current.toolCallMessageIdByCallId[toolCallId] &&
            message.id !== current.toolResultMessageIdByCallId[toolCallId],
        );
        return {
          ...current,
          messages,
          messageIndexById: indexMessages(messages),
        };
      })()
    : current;
  const withSuppressedTool = toolCallId
    ? {
        ...withoutGenericTool,
        subagentToolCallIds: {
          ...withoutGenericTool.subagentToolCallIds,
          [toolCallId]: true as const,
        },
      }
    : withoutGenericTool;
  return upsertMessage(
    withSuppressedTool,
    createActivityMessage(
      messageId,
      activityType,
      content as { text: string; [key: string]: unknown },
      timestampIso(timestamp),
    ),
    runId,
    timestamp,
  );
}

export function withText(message: ChatMessage, content: string): ChatMessage {
  if (message.role === 'activity') {
    return { ...message, content: { ...message.content, text: content } };
  }
  if (message.role === 'assistant') {
    return { ...message, content };
  }
  if (message.role === 'user') {
    return { ...message, content };
  }
  return { ...message, content };
}

export function startToolCall(
  current: AgUiThreadMessageState,
  runId: string,
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string | undefined,
  timestamp?: number,
): AgUiThreadMessageState {
  const messageId = parentMessageId ?? `tool-call:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const assistant: AssistantMessage & { createdAt: string } =
    existing?.role === 'assistant'
      ? {
          ...existing,
          toolCalls: upsertToolCall(existing.toolCalls ?? [], toolCallId, toolCallName, ''),
        }
      : {
          id: messageId,
          role: 'assistant',
          content: '',
          toolCalls: [toolCall(toolCallId, toolCallName, '')],
          createdAt: timestampIso(timestamp),
        };
  const next = upsertMessage(current, assistant, runId, timestamp);
  return {
    ...next,
    toolCallMessageIdByCallId: {
      ...next.toolCallMessageIdByCallId,
      [toolCallId]: messageId,
    },
  };
}
