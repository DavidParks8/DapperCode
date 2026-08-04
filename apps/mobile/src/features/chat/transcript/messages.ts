import { isTerminalSubAgentStatus } from '../message/timelineHelpers';
import { buildToolInvocations, type ToolInvocation } from '../message/toolInvocationModel';
import { isComputerUseTraceEntry } from '../message/computerUseTrace';
import type { ChatMessage, ChatStatus } from '@bridge/types/types';
import {
  COMPACTION_ACTIVITY_TYPE,
  getMessageText,
  getSubAgentMeta,
  getToolCallDisplayLines,
  SUBAGENT_ACTIVITY_TYPE,
} from '@bridge/messages';

/** A computer-use trace only reads well as a whole, so it stays grouped. */
export interface ToolTranscriptGroup {
  kind: 'toolGroup';
  id: string;
  invocations: ToolInvocation[];
}

export interface ToolTranscriptInvocation {
  kind: 'toolInvocation';
  id: string;
  invocation: ToolInvocation;
}

export type TranscriptDisplayItem =
  | {
      kind: 'message';
      message: ChatMessage;
      renderKey: string;
    }
  | ToolTranscriptGroup
  | ToolTranscriptInvocation;

/** Keeps a computer-use trace bounded so very long runs don’t dominate the transcript. */
export const MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP = 14;

const HIDDEN_TRANSCRIPT_MARKERS = [
  'FINAL_TASK_RESULT_JSON',
  'Current working directory is:',
  'You are operating in task worktree',
] as const;

export function getVisibleTranscriptMessages(
  messages: ChatMessage[],
  showToolCalls: boolean,
): ChatMessage[] {
  return messages.filter((message) => shouldDisplayTranscriptMessage(message, showToolCalls));
}

export function buildTranscriptDisplayItems(messages: ChatMessage[]): TranscriptDisplayItem[] {
  const items: TranscriptDisplayItem[] = [];
  let toolBuffer: ChatMessage[] = [];
  let userMessageOrdinal = 0;
  // One tool call is one row, even when other content splits its messages apart,
  // so the row it already produced is refolded instead of a second row appearing
  // under the same identity.
  const flushedToolMessages: ChatMessage[] = [];
  const itemIndexByInvocationId = new Map<string, number>();

  const flushToolBuffer = () => {
    if (toolBuffer.length === 0) {
      return;
    }

    const invocations = buildToolInvocations(toolBuffer);
    const buffered = [...toolBuffer];
    toolBuffer = [];
    if (invocations.length === 0) {
      flushedToolMessages.push(...buffered);
      return;
    }
    if (isComputerUseTrace(invocations)) {
      items.push({
        kind: 'toolGroup',
        id: `tool-group-${buffered[0]?.id ?? 'start'}-${buffered[buffered.length - 1]?.id ?? 'end'}`,
        invocations,
      });
      flushedToolMessages.push(...buffered);
      return;
    }
    const revisitsEarlierInvocation = invocations.some((invocation) =>
      itemIndexByInvocationId.has(invocation.id),
    );
    const refolded = revisitsEarlierInvocation
      ? new Map(
          buildToolInvocations([...flushedToolMessages, ...buffered]).map((invocation) => [
            invocation.id,
            invocation,
          ]),
        )
      : null;
    for (const invocation of invocations) {
      const merged = refolded?.get(invocation.id) ?? invocation;
      const existingIndex = itemIndexByInvocationId.get(invocation.id);
      if (existingIndex === undefined) {
        itemIndexByInvocationId.set(invocation.id, items.length);
        items.push({ kind: 'toolInvocation', id: merged.id, invocation: merged });
        continue;
      }
      items[existingIndex] = { kind: 'toolInvocation', id: merged.id, invocation: merged };
    }
    flushedToolMessages.push(...buffered);
  };

  for (const message of messages) {
    const isToolMessage = isToolTranscriptMessage(message);
    if (isToolMessage) {
      toolBuffer.push(message);
      if (toolBuffer.length >= MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP) {
        flushToolBuffer();
      }
      continue;
    }

    flushToolBuffer();
    if (message.role === 'user') {
      userMessageOrdinal += 1;
    }
    items.push({
      kind: 'message',
      message,
      renderKey: buildTranscriptRenderKey(message, userMessageOrdinal),
    });
  }

  flushToolBuffer();
  return items;
}

export function forkBoundariesByActionMessageId(
  messages: ChatMessage[],
  chatStatus: ChatStatus,
): ReadonlyMap<string, string> {
  const boundaries = new Map<string, string>();
  if (chatStatus === 'running') {
    return boundaries;
  }
  let userOrdinal = 0;
  let precedingResponseId: string | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && !message.pending) {
      precedingResponseId = message.id;
      continue;
    }
    if (message?.role !== 'user') {
      continue;
    }
    userOrdinal += 1;
    if (
      userOrdinal === 1 ||
      !precedingResponseId ||
      message.id.startsWith('msg-') ||
      message.id.startsWith('local-user-')
    ) {
      precedingResponseId = null;
      continue;
    }
    const remainder = messages.slice(index + 1);
    const nextUserIndex = remainder.findIndex((candidate) => candidate.role === 'user');
    const turnMessages = nextUserIndex >= 0 ? remainder.slice(0, nextUserIndex) : remainder;
    const hasSettledResponse = turnMessages.some(
      (candidate) =>
        (candidate.role === 'assistant' || candidate.role === 'reasoning') && !candidate.pending,
    );
    if (hasSettledResponse) {
      boundaries.set(precedingResponseId, message.id);
    }
    precedingResponseId = null;
  }
  return boundaries;
}

function isComputerUseTrace(invocations: ToolInvocation[]): boolean {
  return (
    invocations.length > 0 &&
    invocations.every((invocation) =>
      isComputerUseTraceEntry({
        title: invocation.title.includes('`') ? invocation.title : `\`${invocation.title}\``,
      }),
    )
  );
}

function shouldDisplayTranscriptMessage(message: ChatMessage, showToolCalls: boolean): boolean {
  const text = getMessageText(message);
  const hasToolCalls = getToolCallDisplayLines(message).length > 0;

  return !(
    shouldHideToolTranscriptMessage(message, text, hasToolCalls, showToolCalls) ||
    hasHiddenTranscriptMarker(text) ||
    isBlankAssistantTranscriptMessage(message, text, hasToolCalls)
  );
}

function shouldHideToolTranscriptMessage(
  message: ChatMessage,
  text: string,
  hasToolCalls: boolean,
  showToolCalls: boolean,
): boolean {
  if (showToolCalls) {
    return false;
  }

  return (
    message.role === 'tool' ||
    hasToolCalls ||
    Boolean(message.toolMeta) ||
    isHiddenActivityTranscriptMessage(message)
  );
}

function isHiddenActivityTranscriptMessage(message: ChatMessage): boolean {
  return (
    message.role === 'activity' &&
    message.activityType !== SUBAGENT_ACTIVITY_TYPE &&
    message.activityType !== COMPACTION_ACTIVITY_TYPE
  );
}

function hasHiddenTranscriptMarker(text: string): boolean {
  return HIDDEN_TRANSCRIPT_MARKERS.some((marker) => text.includes(marker));
}

function isBlankAssistantTranscriptMessage(
  message: ChatMessage,
  text: string,
  hasToolCalls: boolean,
): boolean {
  return message.role === 'assistant' && !text.trim() && !hasToolCalls && !message.toolMeta;
}

function isToolTranscriptMessage(message: ChatMessage): boolean {
  if (message.role === 'tool' || message.toolMeta || getToolCallDisplayLines(message).length > 0) {
    return true;
  }
  return false;
}

function buildTranscriptRenderKey(message: ChatMessage, userMessageOrdinal: number): string {
  if (message.role !== 'user') {
    return message.id;
  }

  return `user-${String(userMessageOrdinal)}-${normalizeTranscriptKeyContent(getMessageText(message))}`;
}

function normalizeTranscriptKeyContent(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export function syncVisibleSubAgentStatuses(
  messages: ChatMessage[],
  threadStatuses: ReadonlyMap<string, ChatStatus>,
): ChatMessage[] {
  if (threadStatuses.size === 0) {
    return messages;
  }

  let nextMessages: ChatMessage[] | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const nextMessage = syncSubAgentMessageStatus(message, threadStatuses);

    if (!nextMessages) {
      if (nextMessage === message) {
        continue;
      }
      nextMessages = messages.slice(0, index);
    }

    nextMessages.push(nextMessage);
  }

  return nextMessages ?? messages;
}

function syncSubAgentMessageStatus(
  message: ChatMessage,
  threadStatuses: ReadonlyMap<string, ChatStatus>,
): ChatMessage {
  const subAgentMeta = getSubAgentMeta(message);
  if (!subAgentMeta) {
    return message;
  }

  // The child thread goes back to `idle` once its task ends, so never overwrite a
  // terminal task status with the thread's lifecycle status.
  if (isTerminalSubAgentStatus(subAgentMeta.agentStatus)) {
    return message;
  }

  const receiverThreadIds = subAgentMeta.receiverThreadIds ?? [];
  const nextStatus =
    receiverThreadIds
      .map((threadId) => threadStatuses.get(threadId))
      .find((status): status is ChatStatus => typeof status === 'string') ?? null;

  if (!nextStatus) {
    return message;
  }

  const text = getMessageText(message);
  const nextContent = replaceSubAgentStatusLine(text, nextStatus);
  const previousStatus = subAgentMeta.agentStatus;
  if (nextContent === text && previousStatus === nextStatus) {
    return message;
  }

  if (message.role !== 'activity') {
    return message;
  }
  return {
    ...message,
    content: {
      ...message.content,
      text: nextContent,
      subAgent: {
        ...subAgentMeta,
        agentStatus: nextStatus,
      },
    },
  };
}

function replaceSubAgentStatusLine(content: string, status: ChatStatus): string {
  const statusLine = `Status: ${status}`;
  const lines = content.split('\n');
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (!/^\s*Status:\s*/i.test(line)) {
      return line;
    }

    replaced = true;
    const indentation = line.match(/^\s*/)?.[0] ?? '';
    return `${indentation}${statusLine}`;
  });

  if (replaced) {
    return nextLines.join('\n');
  }

  return [...nextLines, `  ${statusLine}`].join('\n');
}
