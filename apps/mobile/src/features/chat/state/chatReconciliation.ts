import { getMessageText } from '@bridge/messages';
import type { Chat, ChatMessage, ChatSummary } from '@bridge/types/types';
import { countUserMessages, hasRecentUnansweredUserTurn } from '../helpers/helpers';
import { areChatsEquivalent } from './chatEquivalence';

const LOCAL_TRANSCRIPT_MESSAGE_PREFIXES = [
  'local-command-',
  'local-assistant-',
  'local-system-',
] as const;

export function resolveEquivalentChat(previous: Chat, next: Chat): Chat {
  // Merge client-only entries first so later stale-transcript protection cannot discard them.
  const withLocalTranscript = preserveLocalTranscript(previous, next);
  const stabilizedNext = preserveRecentUserTurnTranscript(previous, withLocalTranscript);
  return areChatsEquivalent(previous, stabilizedNext) ? previous : stabilizedNext;
}

export function mergeChatSummaryPreservingMessages(previous: Chat, summary: ChatSummary): Chat {
  const next = {
    ...previous,
    ...summary,
    messages: previous.messages,
  };
  return areChatsEquivalent(previous, next) ? previous : next;
}

function preserveRecentUserTurnTranscript(previous: Chat, next: Chat): Chat {
  if (previous.id !== next.id) {
    return next;
  }

  // A summary-only bridge fallback has no turns and must not erase already-hydrated history.
  if (previous.messages.length > 0 && next.messages.length === 0) {
    return withPreviousTranscript(previous, next);
  }

  const previousUserCount = countUserMessages(previous.messages);
  const nextUserCount = countUserMessages(next.messages);
  if (nextUserCount >= previousUserCount) {
    return next;
  }

  const shouldPreserveTranscript =
    hasRecentUnansweredUserTurn(previous) ||
    previous.status === 'running' ||
    next.status === 'running';
  if (!shouldPreserveTranscript) {
    return next;
  }

  const latestUserIndex = findLatestUserMessageIndex(previous.messages);
  const latestUser = previous.messages[latestUserIndex];
  const nextUserIndex = latestUser
    ? next.messages.findIndex((message) => messagesShareTranscriptIdentity(latestUser, message))
    : -1;
  if (nextUserIndex < 0 || nextUserIndex === next.messages.length - 1) {
    return withPreviousTranscript(previous, next);
  }

  // Bounded bridge snapshots are authoritative tails. Keep hydrated history ahead of the
  // latest user turn, but let the snapshot supply that turn and its completed response.
  return mergeBoundedTranscriptTail(previous, next, latestUserIndex);
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
