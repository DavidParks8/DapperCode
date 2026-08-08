import type { Chat, ChatMessage } from '@bridge/types/types';
import type { AgUiThreadMessageState } from '@bridge/agui/agUiMessages';
import { getMessageText, getSubAgentMeta, preserveKnownSubAgentThreadLink } from '@bridge/messages';
import { partsMatchMessageContent } from '@bridge/agui/agUiContent';
import { filterReasoningMessages, normalizeChatMessageMatchContent } from '../../helpers/helpers';
import { trimInheritedParentMessages } from '../../agents/transcript';
import { getVisibleTranscriptMessages, syncVisibleSubAgentStatuses } from '../messages';

export interface TranscriptProjection {
  messages: ChatMessage[];
  hiddenInheritedMessageCount: number;
}

interface TranscriptProjectionBase {
  messages: ChatMessage[];
  liveMessages: ChatMessage[];
  replacedMessageIds: Set<string>;
  hiddenInheritedMessageCount: number;
}

export function projectTranscript({
  chat,
  parentChat,
  showToolCalls,
  threadStatuses,
  liveMessageState,
  now = () => new Date().toISOString(),
}: {
  chat: Chat;
  parentChat: Chat | null;
  showToolCalls: boolean;
  threadStatuses: ReadonlyMap<string, Chat['status']>;
  liveMessageState?: AgUiThreadMessageState | null;
  now?: () => string;
}): TranscriptProjection {
  const base = buildTranscriptProjectionBase({
    chat,
    parentChat,
    showToolCalls,
    threadStatuses,
    liveMessageState,
  });
  const messagesWithSnapshot = liveMessageState?.authoritativeSnapshot
    ? applyAuthoritativeSnapshot(base.messages, base.liveMessages, base.replacedMessageIds, now)
    : base.messages;
  const messages = mergeLiveMessages(
    messagesWithSnapshot,
    base.liveMessages,
    base.replacedMessageIds,
    liveMessageState,
    now,
  );

  return {
    messages,
    hiddenInheritedMessageCount: base.hiddenInheritedMessageCount,
  };
}

/**
 * A tool invocation is worth showing the moment it starts, before it has any
 * output, so a message that only carries tool activity is not empty.
 */
function carriesToolActivity(message: ChatMessage): boolean {
  if (message.toolMeta) {
    return true;
  }
  return message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0;
}

function buildTranscriptProjectionBase({
  chat,
  parentChat,
  showToolCalls,
  threadStatuses,
  liveMessageState,
}: {
  chat: Chat;
  parentChat: Chat | null;
  showToolCalls: boolean;
  threadStatuses: ReadonlyMap<string, Chat['status']>;
  liveMessageState?: AgUiThreadMessageState | null;
}): TranscriptProjectionBase {
  const childMessages = getVisibleTranscriptMessages(
    filterReasoningMessages(chat.messages),
    showToolCalls,
  );
  const parentMessages = getProjectedParentMessages(chat, parentChat, showToolCalls);
  const inheritedMessages = parentMessages
    ? trimInheritedParentMessages(parentMessages, childMessages, chat.id)
    : { messages: childMessages, hiddenInheritedMessageCount: 0 };
  const messages = dedupeTransientUserMessages(
    syncVisibleSubAgentStatuses(inheritedMessages.messages, threadStatuses),
  );
  const rawLiveMessages = liveMessageState?.messages ?? [];

  return {
    messages,
    liveMessages: parentMessages
      ? trimInheritedParentMessages(parentMessages, rawLiveMessages, chat.id).messages
      : rawLiveMessages,
    replacedMessageIds: new Set(
      Object.values(liveMessageState?.replacesMessageIdByMessageId ?? {}),
    ),
    hiddenInheritedMessageCount: inheritedMessages.hiddenInheritedMessageCount,
  };
}

function getProjectedParentMessages(
  chat: Chat,
  parentChat: Chat | null,
  showToolCalls: boolean,
): ChatMessage[] | null {
  if (!chat.parentThreadId || !parentChat) {
    return null;
  }

  return getVisibleTranscriptMessages(filterReasoningMessages(parentChat.messages), showToolCalls);
}

function applyAuthoritativeSnapshot(
  messages: ChatMessage[],
  liveMessages: ChatMessage[],
  replacedMessageIds: Set<string>,
  now: () => string,
): ChatMessage[] {
  const projectedMessages = projectAuthoritativeLiveMessages(
    messages,
    liveMessages,
    replacedMessageIds,
    now,
  );
  const liveIds = new Set(liveMessages.map((message) => message.id));
  const coverage = getAuthoritativeSnapshotCoverage(messages, liveIds);
  if (
    shouldKeepPersistedMessagesAheadOfSnapshot(
      messages,
      projectedMessages,
      coverage.lastCoveredIndex,
    )
  ) {
    return prependPersistedMessagesAheadOfSnapshot(messages, projectedMessages, liveIds);
  }

  return buildAuthoritativeMergedMessages(
    messages,
    projectedMessages,
    coverage,
    liveIds,
    replacedMessageIds,
  );
}

function projectAuthoritativeLiveMessages(
  messages: ChatMessage[],
  liveMessages: ChatMessage[],
  replacedMessageIds: Set<string>,
  now: () => string,
): ChatMessage[] {
  const persistedById = new Map(messages.map((message) => [message.id, message]));
  return liveMessages
    .filter(
      (message) => !replacedMessageIds.has(message.id) && hasVisibleLiveMessageContent(message),
    )
    .map((message) => {
      const persisted = persistedById.get(message.id);
      const parts = persisted?.parts ?? message.parts;
      return {
        ...message,
        createdAt: persisted?.createdAt || message.createdAt || now(),
        // A live event never reports what the turn cost, so the persisted copy stays the only
        // source of the per-response usage the transcript reports.
        usage: message.usage ?? persisted?.usage ?? null,
        // Ordered parts win over `content` when rendering, so drop them when
        // they no longer describe the authoritative snapshot text.
        parts: partsMatchMessageContent(parts, message.content) ? parts : undefined,
      };
    });
}

function hasVisibleLiveMessageContent(message: ChatMessage): boolean {
  return Boolean(getMessageText(message).trim() || carriesToolActivity(message));
}

function getAuthoritativeSnapshotCoverage(
  messages: ChatMessage[],
  liveIds: ReadonlySet<string>,
): { firstCoveredIndex: number; lastCoveredIndex: number } {
  return {
    firstCoveredIndex: messages.findIndex((message) => liveIds.has(message.id)),
    lastCoveredIndex: messages.reduce(
      (last, message, index) => (liveIds.has(message.id) ? index : last),
      -1,
    ),
  };
}

function shouldKeepPersistedMessagesAheadOfSnapshot(
  messages: ChatMessage[],
  projectedMessages: ChatMessage[],
  lastCoveredIndex: number,
): boolean {
  return lastCoveredIndex < 0 && projectedMessages.length > 0 && messages.length > 0;
}

function prependPersistedMessagesAheadOfSnapshot(
  messages: ChatMessage[],
  projectedMessages: ChatMessage[],
  liveIds: ReadonlySet<string>,
): ChatMessage[] {
  // The snapshot shares nothing with what we already have, so it describes a
  // later segment of the conversation rather than the whole of it -- an agent
  // that resumes a thread snapshots only the turn it just ran. Treating it as
  // the entire transcript erases every earlier turn the moment a follow-up is
  // sent, so the known history is kept ahead of it.
  const snapshotSignatures = new Set(
    projectedMessages.map((message) => buildTranscriptSignature(message)),
  );
  const leadingMessages = messages.filter(
    (message) =>
      !liveIds.has(message.id) && !snapshotSignatures.has(buildTranscriptSignature(message)),
  );
  return [...leadingMessages, ...projectedMessages];
}

function buildTranscriptSignature(message: ChatMessage): string {
  return `${message.role}\u0000${getMessageText(message).trim()}`;
}

function buildAuthoritativeMergedMessages(
  messages: ChatMessage[],
  projectedMessages: ChatMessage[],
  coverage: { firstCoveredIndex: number; lastCoveredIndex: number },
  liveIds: ReadonlySet<string>,
  replacedMessageIds: ReadonlySet<string>,
): ChatMessage[] {
  const leadingMessages =
    coverage.firstCoveredIndex >= 0
      ? messages
          .slice(0, coverage.firstCoveredIndex)
          .filter((message) => !replacedMessageIds.has(message.id))
      : [];
  const trailingMessages =
    coverage.lastCoveredIndex >= 0
      ? messages.slice(coverage.lastCoveredIndex + 1).filter((message) => !liveIds.has(message.id))
      : [];
  return [...leadingMessages, ...projectedMessages, ...trailingMessages];
}

function mergeLiveMessages(
  messages: ChatMessage[],
  liveMessages: ChatMessage[],
  replacedMessageIds: ReadonlySet<string>,
  liveMessageState: AgUiThreadMessageState | null | undefined,
  now: () => string,
): ChatMessage[] {
  let nextMessages = messages;
  for (const liveMessage of liveMessages) {
    nextMessages = mergeLiveMessage(
      nextMessages,
      liveMessage,
      replacedMessageIds,
      liveMessageState,
      now,
    );
  }
  return nextMessages;
}

function mergeLiveMessage(
  messages: ChatMessage[],
  liveMessage: ChatMessage,
  replacedMessageIds: ReadonlySet<string>,
  liveMessageState: AgUiThreadMessageState | null | undefined,
  now: () => string,
): ChatMessage[] {
  const liveText = getMessageText(liveMessage).trim();
  if ((!liveText && !carriesToolActivity(liveMessage)) || replacedMessageIds.has(liveMessage.id)) {
    return messages;
  }

  const persistedMessage = findPersistedLiveMessage(messages, liveMessage);
  if (!persistedMessage) {
    return [
      ...messages,
      {
        ...liveMessage,
        createdAt: liveMessage.createdAt || now(),
      },
    ];
  }

  const useLiveContent = shouldReplacePersistedLiveMessage(
    persistedMessage,
    liveMessage,
    liveText,
    liveMessageState,
  );
  // Discovery can add the child link in a shorter status-only activity. Metadata must not inherit
  // the text merge's protection against shorter, potentially stale message content.
  const useLiveSubAgentLink = hasNewLiveSubAgentThreadLink(persistedMessage, liveMessage);
  const useLivePending = shouldAdoptLivePendingState(persistedMessage, liveMessage);
  const useLiveCompletion =
    liveMessage.completedAt !== undefined &&
    liveMessage.completedAt !== persistedMessage.completedAt;
  if (!useLiveContent && !useLiveSubAgentLink && !useLivePending && !useLiveCompletion) {
    return messages;
  }
  return replacePersistedLiveMessage(messages, persistedMessage, liveMessage, liveText, {
    useLiveContent,
    useLiveSubAgentLink,
    useLivePending,
    useLiveCompletion,
  });
}

function findPersistedLiveMessage(
  messages: ChatMessage[],
  liveMessage: ChatMessage,
): ChatMessage | undefined {
  const exactPersistedMessage = messages.find(
    (message) =>
      message.role === liveMessage.role &&
      (message.id === liveMessage.id || liveMessage.id.endsWith(`::item::${message.id}`)),
  );
  if (exactPersistedMessage) {
    return exactPersistedMessage;
  }

  const trailingMessage = messages.at(-1);
  return isMatchingTrailingUserMessage(trailingMessage, liveMessage) ? trailingMessage : undefined;
}

function isMatchingTrailingUserMessage(
  trailingMessage: ChatMessage | undefined,
  liveMessage: ChatMessage,
): boolean {
  return (
    liveMessage.role === 'user' &&
    trailingMessage?.role === 'user' &&
    normalizeChatMessageMatchContent(getMessageText(trailingMessage)) ===
      normalizeChatMessageMatchContent(getMessageText(liveMessage))
  );
}

function shouldReplacePersistedLiveMessage(
  persistedMessage: ChatMessage,
  liveMessage: ChatMessage,
  liveText: string,
  liveMessageState: AgUiThreadMessageState | null | undefined,
): boolean {
  const persistedText = getMessageText(persistedMessage).trim();
  const liveExtendsPersisted = liveText.startsWith(persistedText);
  const persistedExtendsLive = persistedText.startsWith(liveText);
  return (
    !liveMessageState?.terminalMessageIds.includes(liveMessage.id) &&
    liveMessage.role !== 'user' &&
    liveText !== persistedText &&
    (liveExtendsPersisted || !persistedExtendsLive)
  );
}

/**
 * The live copy owns the reasoning `pending` flag, so a settled run has to hand that
 * state to the persisted message even when the text itself is already up to date.
 */
function shouldAdoptLivePendingState(
  persistedMessage: ChatMessage,
  liveMessage: ChatMessage,
): boolean {
  return liveMessage.pending !== undefined && liveMessage.pending !== persistedMessage.pending;
}

function hasNewLiveSubAgentThreadLink(
  persistedMessage: ChatMessage,
  liveMessage: ChatMessage,
): boolean {
  if (persistedMessage.role !== 'activity' || liveMessage.role !== 'activity') {
    return false;
  }
  const persistedMeta = getSubAgentMeta(persistedMessage);
  const liveMeta = getSubAgentMeta(liveMessage);
  const persistedIds = new Set(
    (persistedMeta?.receiverThreadIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  return (liveMeta?.receiverThreadIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean)
    .some((id) => !persistedIds.has(id));
}

function replacePersistedLiveMessage(
  messages: ChatMessage[],
  persistedMessage: ChatMessage,
  liveMessage: ChatMessage,
  liveText: string,
  {
    useLiveContent,
    useLiveSubAgentLink,
    useLivePending,
    useLiveCompletion,
  }: {
    useLiveContent: boolean;
    useLiveSubAgentLink: boolean;
    useLivePending: boolean;
    useLiveCompletion: boolean;
  },
): ChatMessage[] {
  return messages.map((message) => {
    if (message !== persistedMessage) {
      return message;
    }
    if (
      message.role === 'activity' &&
      liveMessage.role === 'activity' &&
      (useLiveContent || useLiveSubAgentLink)
    ) {
      return preserveKnownSubAgentThreadLink(message, {
        ...message,
        content: {
          ...message.content,
          ...liveMessage.content,
          text: useLiveContent ? liveText : message.content.text,
        },
        ...(useLiveContent ? { parts: liveMessage.parts ?? message.parts } : {}),
        ...(useLivePending ? { pending: liveMessage.pending } : {}),
        ...(useLiveCompletion ? { completedAt: liveMessage.completedAt } : {}),
      });
    }
    return {
      ...message,
      ...(useLiveContent
        ? {
            content: liveText,
            parts: liveMessage.parts ?? message.parts,
          }
        : {}),
      ...(useLivePending ? { pending: liveMessage.pending } : {}),
      ...(useLiveCompletion ? { completedAt: liveMessage.completedAt } : {}),
    } as ChatMessage;
  });
}

function dedupeTransientUserMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message, index) => {
    if (!isTransientUserMessage(message)) {
      return true;
    }
    const content = normalizeChatMessageMatchContent(getMessageText(message));
    if (!content) {
      return true;
    }
    return ![messages[index - 1], messages[index + 1]].some(
      (neighbor) =>
        neighbor?.role === 'user' &&
        !isTransientUserMessage(neighbor) &&
        normalizeChatMessageMatchContent(getMessageText(neighbor)) === content,
    );
  });
}

function isTransientUserMessage(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    (message.id.startsWith('msg-') || message.id.startsWith('local-user-'))
  );
}
