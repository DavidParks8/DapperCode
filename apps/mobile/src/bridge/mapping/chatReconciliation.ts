import { getAgentMessageMeta, getMessageText } from '@bridge/messages';
import type { Chat, ChatMessage } from '@bridge/types/types';

const LOCAL_TRANSCRIPT_MESSAGE_PREFIXES = [
  'local-command-',
  'local-assistant-',
  'local-system-',
] as const;

export function reconcileChatTranscript(previous: Chat, next: Chat): Chat {
  // Merge client-only entries first so later stale-transcript protection cannot discard them.
  const withLocalTranscript = preserveLocalTranscript(previous, next);
  return preserveRecentUserTurnTranscript(previous, withLocalTranscript);
}

export function isChatHistoryIncomplete(previous: Chat | null, next: Chat): boolean {
  if (next.acpSnapshot?.session.historyReconstruction) {
    return true;
  }
  if (!previous || previous.id !== next.id || next.acpSnapshot?.messageCollection?.truncated) {
    return false;
  }
  const latestUserIndex = findLatestUserMessageIndex(previous.messages);
  if (latestUserIndex < 0 && next.messages.length > 0) {
    return false;
  }
  const knownMessages = previous.messages
    .slice(Math.max(0, latestUserIndex))
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        !isLocalTranscriptMessage(message),
    );
  return findRepresentedMessageIndexes(knownMessages, next.messages).size < knownMessages.length;
}

function preserveRecentUserTurnTranscript(previous: Chat, next: Chat): Chat {
  if (previous.id !== next.id) {
    return next;
  }

  if (isAgentMessageOnlySnapshot(next) && hasOrdinaryTranscript(previous)) {
    return mergeAgentMessageOnlySnapshot(previous, next);
  }

  if (isChatHistoryIncomplete(previous, next)) {
    return withPreviousTranscript(previous, next);
  }

  // A summary-only bridge fallback has no turns and must not erase already-hydrated history.
  if (previous.messages.length > 0 && next.messages.length === 0) {
    return withPreviousTranscript(previous, next);
  }

  const previousUserCount = previous.messages.filter((message) => message.role === 'user').length;
  const nextUserCount = next.messages.filter((message) => message.role === 'user').length;
  if (nextUserCount >= previousUserCount && !next.acpSnapshot?.messageCollection?.truncated) {
    return next;
  }

  const latestUserIndex = findLatestUserMessageIndex(previous.messages);
  const latestUser = previous.messages[latestUserIndex];
  const nextUserIndex = latestUser
    ? next.messages.findIndex((message) => messagesShareTranscriptIdentity(latestUser, message))
    : -1;
  if (nextUserIndex < 0) {
    return reconcileMissingUserTurn(previous, next);
  }
  if (nextUserIndex === next.messages.length - 1) {
    return withPreviousTranscript(previous, next);
  }

  // Bounded bridge snapshots are authoritative tails. Keep hydrated history ahead of the
  // latest user turn, but let the snapshot supply that turn and its completed response.
  return mergeBoundedTranscriptTail(previous, next, latestUserIndex);
}

function reconcileMissingUserTurn(previous: Chat, next: Chat): Chat {
  const collection = next.acpSnapshot?.messageCollection;
  if (collection?.truncated) {
    const previousRevision = previous.acpSnapshot?.messageCollection?.revision;
    if (
      previousRevision !== undefined &&
      (collection.revision < previousRevision ||
        (collection.revision === previousRevision && previous.messages.at(-1)?.role === 'user'))
    ) {
      return previous;
    }
    // Long turns can evict their kickoff from the bounded snapshot. Its absence does not make
    // the recovered response stale; retain known history ahead of the authoritative tail.
    return mergeBoundedTranscriptTail(previous, next, previous.messages.length);
  }
  return withPreviousTranscript(previous, next);
}

function findLatestUserMessageIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

function withPreviousTranscript(previous: Chat, next: Chat): Chat {
  return {
    ...next,
    lastMessagePreview: previous.lastMessagePreview,
    messages: previous.messages,
  };
}

function mergeBoundedTranscriptTail(previous: Chat, next: Chat, latestUserIndex: number): Chat {
  const representedPreviousIndexes = findRepresentedMessageIndexes(
    previous.messages,
    next.messages,
  );
  const preservedHistory = previous.messages
    .slice(0, latestUserIndex)
    .filter((_, index) => !representedPreviousIndexes.has(index));
  return {
    ...next,
    messages: [...preservedHistory, ...next.messages],
  };
}

function findRepresentedMessageIndexes(
  previous: ChatMessage[],
  next: ChatMessage[],
): ReadonlySet<number> {
  const represented = new Set<number>();
  const previousIndexById = new Map(previous.map((message, index) => [message.id, index]));
  for (const nextMessage of next) {
    const matchingIdIndex = previousIndexById.get(nextMessage.id);
    if (matchingIdIndex !== undefined) {
      represented.add(matchingIdIndex);
      continue;
    }

    for (let index = previous.length - 1; index >= 0; index -= 1) {
      const previousMessage = previous[index];
      if (
        previousMessage &&
        !represented.has(index) &&
        messagesShareTranscriptIdentity(previousMessage, nextMessage)
      ) {
        represented.add(index);
        break;
      }
    }
  }
  return represented;
}

function isAgentMessageOnlySnapshot(chat: Chat): boolean {
  return chat.messages.length > 0 && chat.messages.every((message) => getAgentMessageMeta(message));
}

function hasOrdinaryTranscript(chat: Chat): boolean {
  return chat.messages.some((message) => !getAgentMessageMeta(message));
}

function mergeAgentMessageOnlySnapshot(previous: Chat, next: Chat): Chat {
  const nextMessagesById = new Map(next.messages.map((message) => [message.id, message]));
  const messages = previous.messages.map((message) => nextMessagesById.get(message.id) ?? message);
  const mergedMessageIds = new Set(messages.map((message) => message.id));
  for (const message of next.messages) {
    if (!mergedMessageIds.has(message.id)) {
      messages.push(message);
      mergedMessageIds.add(message.id);
    }
  }
  return {
    ...next,
    lastMessagePreview: previous.lastMessagePreview,
    messages,
  };
}

function messagesShareTranscriptIdentity(left: ChatMessage, right: ChatMessage): boolean {
  if (left.id === right.id) {
    return true;
  }
  const leftText = getMessageText(left).trim();
  return left.role === right.role && Boolean(leftText) && leftText === getMessageText(right).trim();
}

function preserveLocalTranscript(previous: Chat, next: Chat): Chat {
  if (
    previous.id !== next.id ||
    !previous.messages.some((message) => isLocalTranscriptMessage(message))
  ) {
    return next;
  }

  const nextMessagesById = new Map(next.messages.map((message) => [message.id, message]));
  const messages = previous.messages.map((message) => nextMessagesById.get(message.id) ?? message);
  const mergedMessageIds = new Set(messages.map((message) => message.id));

  for (const message of next.messages) {
    if (mergedMessageIds.has(message.id)) {
      continue;
    }
    insertMessageByTimestamp(messages, message);
    mergedMessageIds.add(message.id);
  }

  const lastMessage = messages[messages.length - 1];
  return {
    ...next,
    lastMessagePreview: isLocalTranscriptMessage(lastMessage)
      ? previous.lastMessagePreview
      : next.lastMessagePreview,
    messages,
  };
}

function isLocalTranscriptMessage(message: ChatMessage | undefined): boolean {
  return Boolean(
    message && LOCAL_TRANSCRIPT_MESSAGE_PREFIXES.some((prefix) => message.id.startsWith(prefix)),
  );
}

function insertMessageByTimestamp(messages: ChatMessage[], message: ChatMessage): void {
  const createdAtMs = Date.parse(message.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    messages.push(message);
    return;
  }

  const insertionIndex = messages.findIndex((candidate) => {
    const candidateCreatedAtMs = Date.parse(candidate.createdAt);
    return Number.isFinite(candidateCreatedAtMs) && candidateCreatedAtMs > createdAtMs;
  });
  if (insertionIndex < 0) {
    messages.push(message);
  } else {
    messages.splice(insertionIndex, 0, message);
  }
}
