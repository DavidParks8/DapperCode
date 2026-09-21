import type { Chat, ChatMessage } from '@bridge/types/types';
import type { AgUiThreadMessageState } from '@bridge/agui/agUiMessages';
import {
  getMessageText,
  getSubAgentMeta,
  isUnlinkedSubAgentActivity,
  isTransientUserMessage,
  preserveKnownSubAgentThreadLink,
} from '@bridge/messages';
import { filterReasoningMessages, normalizeChatMessageMatchContent } from '../../helpers/helpers';
import { trimInheritedParentMessages } from '../../agents/transcript';
import { getMessageToolCallId } from '../../message/toolInvocationModel';
import { getVisibleTranscriptMessages, syncVisibleSubAgentStatuses } from '../messages';
import {
  applyAuthoritativeSnapshot,
  carriesToolActivity,
  getSnapshotRunRelation,
} from './snapshotProjection';

export interface TranscriptProjection {
  messages: ChatMessage[];
  hiddenInheritedMessageCount: number;
}

interface TranscriptProjectionBase {
  messages: ChatMessage[];
  liveMessages: ChatMessage[];
  snapshotMessageIds: Set<string> | null;
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
  const snapshotMessageIds = base.snapshotMessageIds;
  const snapshotMessages = base.liveMessages.filter((message) =>
    snapshotMessageIds?.has(message.id),
  );
  const snapshotWindowTruncated = Boolean(
    liveMessageState?.snapshotMessageIds?.some(
      (id) => !liveMessageState.messages.some((message) => message.id === id),
    ),
  );
  const messagesWithSnapshot =
    snapshotMessages.length > 0 ||
    (snapshotMessageIds?.size === 0 && base.liveMessages.length === 0)
      ? applyAuthoritativeSnapshot(
          base.messages,
          // Later live events do not extend an older snapshot's ordering authority.
          snapshotMessages,
          base.replacedMessageIds,
          now,
          getSnapshotRunRelation(liveMessageState, chat),
          snapshotWindowTruncated,
        )
      : { messages: base.messages, aliases: new Map<string, string>() };
  const messages = mergeLiveMessages(
    messagesWithSnapshot.messages,
    base.liveMessages,
    base.replacedMessageIds,
    liveMessageState,
    now,
    chat,
    messagesWithSnapshot.aliases,
  );

  return {
    messages: messages.filter(
      (message) => !base.replacedMessageIds.has(message.id) && !isUnlinkedSubAgentActivity(message),
    ),
    hiddenInheritedMessageCount: base.hiddenInheritedMessageCount,
  };
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
  const snapshotMessageIds = liveMessageState?.snapshotMessageIds
    ? new Set(liveMessageState.snapshotMessageIds)
    : null;
  const rawLiveMessages = (liveMessageState?.messages ?? []).map((message) => {
    const reconstructed = findReconstructedUserMessage(messages, message, liveMessageState);
    if (reconstructed && snapshotMessageIds?.delete(message.id)) {
      snapshotMessageIds.add(reconstructed.id);
    }
    return reconstructed ? { ...message, id: reconstructed.id } : message;
  });

  return {
    messages,
    snapshotMessageIds,
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

function mergeLiveMessages(
  messages: ChatMessage[],
  liveMessages: ChatMessage[],
  replacedMessageIds: ReadonlySet<string>,
  liveMessageState: AgUiThreadMessageState | null | undefined,
  now: () => string,
  chat: Chat,
  aliases: ReadonlyMap<string, string>,
): ChatMessage[] {
  let nextMessages = messages;
  const anchors = liveMessages.map((message) => {
    const persisted = findPersistedLiveMessage(messages, message, aliases);
    if (persisted) {
      return persisted.id;
    }
    const toolCallId = getMessageToolCallId(message);
    return toolCallId
      ? messages.find((candidate) => getMessageToolCallId(candidate) === toolCallId)?.id
      : undefined;
  });
  for (const [index, liveMessage] of liveMessages.entries()) {
    nextMessages = mergeLiveMessage(
      nextMessages,
      liveMessage,
      replacedMessageIds,
      liveMessageState,
      now,
      chat,
      anchors.slice(index + 1).find((id) => id !== undefined),
      aliases,
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
  chat: Chat,
  followingMessageId: string | undefined,
  aliases: ReadonlyMap<string, string>,
): ChatMessage[] {
  const liveText = getMessageText(liveMessage).trim();
  if ((!liveText && !carriesToolActivity(liveMessage)) || replacedMessageIds.has(liveMessage.id)) {
    return messages;
  }

  const persistedMessage = findPersistedLiveMessage(messages, liveMessage, aliases);
  if (!persistedMessage) {
    const replacedId = liveMessageState?.replacesMessageIdByMessageId[liveMessage.id];
    return insertLiveMessage(
      messages,
      liveMessage,
      followingMessageId,
      replacedId ? (aliases.get(replacedId) ?? replacedId) : undefined,
      now,
    );
  }

  function insertLiveMessage(
    messages: ChatMessage[],
    message: ChatMessage,
    followingId: string | undefined,
    replacedId: string | undefined,
    now: () => string,
  ): ChatMessage[] {
    const replacedIndex = messages.findIndex((candidate) => candidate.id === replacedId);
    const followingIndex = messages.findIndex((candidate) => candidate.id === followingId);
    const index =
      replacedIndex >= 0 ? replacedIndex : followingIndex >= 0 ? followingIndex : messages.length;
    const replaced = messages[replacedIndex];
    return [
      ...messages.slice(0, index),
      {
        ...message,
        createdAt: replaced?.createdAt || message.createdAt || now(),
        usage: message.usage ?? replaced?.usage ?? null,
      },
      ...messages.slice(index + (replacedIndex >= 0 ? 1 : 0)),
    ];
  }

  const useLiveContent = shouldReplacePersistedLiveMessage(
    persistedMessage,
    liveMessage,
    liveText,
    liveMessageState,
    chat,
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

function findReconstructedUserMessage(
  messages: ChatMessage[],
  liveMessage: ChatMessage,
  state: AgUiThreadMessageState | null | undefined,
): ChatMessage | undefined {
  const runId = state?.runByMessageId[liveMessage.id];
  if (liveMessage.role !== 'user' || !state || !runId) {
    return undefined;
  }
  const following = state.messages.slice(state.messages.indexOf(liveMessage) + 1);
  for (const candidate of following) {
    if (candidate.role === 'user') {
      break;
    }
    if (candidate.role !== 'assistant' || state.runByMessageId[candidate.id] !== runId) {
      continue;
    }
    const answer = findPersistedLiveMessage(messages, candidate);
    if (answer) {
      // A replayed prompt may have a different ID after ACP load. Anchor it to its
      // known answer, not text alone: a later turn can legitimately repeat the prompt.
      const user = messages
        .slice(0, messages.indexOf(answer))
        .reverse()
        .find((message) => message.role === 'user');
      return isMatchingTrailingUserMessage(user, liveMessage) ? user : undefined;
    }
  }
  return undefined;
}

function findPersistedLiveMessage(
  messages: ChatMessage[],
  liveMessage: ChatMessage,
  aliases?: ReadonlyMap<string, string>,
): ChatMessage | undefined {
  const exactPersistedMessage = messages.find(
    (message) =>
      message.role === liveMessage.role &&
      (message.id === (aliases?.get(liveMessage.id) ?? liveMessage.id) ||
        liveMessage.id.endsWith(`::item::${message.id}`)),
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
  chat: Chat,
): boolean {
  const persistedText = getMessageText(persistedMessage).trim();
  const liveExtendsPersisted = liveText.startsWith(persistedText);
  const persistedExtendsLive = persistedText.startsWith(liveText);
  const terminal = liveMessageState?.terminalMessageIds.includes(liveMessage.id);
  const afterSnapshot =
    liveMessageState?.snapshotMessageIds != null &&
    !liveMessageState.snapshotMessageIds.includes(liveMessage.id);
  const snapshot = chat.acpSnapshot;
  const settledPersistedMessage =
    snapshot &&
    !chat.historyRecoveryError &&
    !snapshot.active.runId &&
    !snapshot.session.historyReconstruction &&
    snapshot.messages.some((message) => message.id === persistedMessage.id);
  // An end event settles the stream, not the last cached read. Preserve its unseen suffix
  // until a settled authoritative read actually includes this response.
  const keepCompletedProgress = afterSnapshot && liveExtendsPersisted && !settledPersistedMessage;
  return (
    (!terminal || keepCompletedProgress) &&
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
