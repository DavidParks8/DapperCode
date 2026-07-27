import type { Chat, ChatMessage } from '../../../api/types';
import type { AgUiThreadMessageState } from '../../../api/agUiMessages';
import { getMessageText } from '../../../api/messages';
import { partsMatchMessageContent } from '../../../api/agUiContent';
import { filterReasoningMessages, normalizeChatMessageMatchContent } from '../mainScreenHelpers';
import { trimInheritedParentMessages } from '../subAgentTranscript';
import {
  buildTranscriptDisplayItems,
  getVisibleTranscriptMessages,
  syncVisibleSubAgentStatuses,
  type TranscriptDisplayItem,
} from '../transcriptMessages';

export interface TranscriptProjection {
  messages: ChatMessage[];
  items: TranscriptDisplayItem[];
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
  const child = getVisibleTranscriptMessages(filterReasoningMessages(chat.messages), showToolCalls);
  const inherited =
    chat.parentThreadId && parentChat
      ? trimInheritedParentMessages(
          getVisibleTranscriptMessages(filterReasoningMessages(parentChat.messages), showToolCalls),
          child,
          chat.id,
        )
      : { messages: child, hiddenInheritedMessageCount: 0 };
  let messages = dedupeTransientUserMessages(
    syncVisibleSubAgentStatuses(inherited.messages, threadStatuses),
  );
  const liveMessages = liveMessageState?.messages ?? [];
  const replacedMessageIds = new Set(
    Object.values(liveMessageState?.replacesMessageIdByMessageId ?? {}),
  );
  if (liveMessageState?.authoritativeSnapshot) {
    const persistedById = new Map(messages.map((message) => [message.id, message]));
    const liveIds = new Set(liveMessages.map((message) => message.id));
    const projected = liveMessages
      .filter(
        (message) =>
          !replacedMessageIds.has(message.id) &&
          (getMessageText(message).trim() || carriesToolActivity(message)),
      )
      .map((message) => {
        const persisted = persistedById.get(message.id);
        const parts = persisted?.parts ?? message.parts;
        return {
          ...message,
          createdAt: persisted?.createdAt || message.createdAt || now(),
          // Ordered parts win over `content` when rendering, so drop them when
          // they no longer describe the authoritative snapshot text.
          parts: partsMatchMessageContent(parts, message.content) ? parts : undefined,
        } as ChatMessage;
      });
    // The snapshot is only authoritative for the runs it was built from. A prompt
    // sent after it is already persisted but not in the snapshot yet, so keep the
    // trailing persisted messages instead of dropping them until the next one.
    const lastCoveredIndex = messages.reduce(
      (last, message, index) => (liveIds.has(message.id) ? index : last),
      -1,
    );
    const trailing =
      lastCoveredIndex >= 0
        ? messages.slice(lastCoveredIndex + 1).filter((message) => !liveIds.has(message.id))
        : [];
    if (lastCoveredIndex < 0 && projected.length > 0 && messages.length > 0) {
      // The snapshot shares nothing with what we already have, so it describes a
      // later segment of the conversation rather than the whole of it -- an agent
      // that resumes a thread snapshots only the turn it just ran. Treating it as
      // the entire transcript erases every earlier turn the moment a follow-up is
      // sent, so the known history is kept ahead of it.
      const snapshotSignatures = new Set(
        projected.map((message) => `${message.role}\u0000${getMessageText(message).trim()}`),
      );
      const leading = messages.filter(
        (message) =>
          !liveIds.has(message.id) &&
          !snapshotSignatures.has(`${message.role}\u0000${getMessageText(message).trim()}`),
      );
      messages = [...leading, ...projected];
    } else {
      messages = [...projected, ...trailing];
    }
  }
  for (const liveAssistantMessage of liveMessages) {
    const liveText = getMessageText(liveAssistantMessage).trim();
    if (!liveText && !carriesToolActivity(liveAssistantMessage)) {
      continue;
    }
    if (replacedMessageIds.has(liveAssistantMessage.id)) {
      continue;
    }
    const exactPersistedMessage = messages.find(
      (message) =>
        message.role === liveAssistantMessage.role &&
        (message.id === liveAssistantMessage.id ||
          liveAssistantMessage.id.endsWith(`::item::${message.id}`)),
    );
    const trailingMessage = messages.at(-1);
    const persistedLiveMessage =
      exactPersistedMessage ??
      (liveAssistantMessage.role === 'user' &&
      trailingMessage?.role === 'user' &&
      normalizeChatMessageMatchContent(getMessageText(trailingMessage)) ===
        normalizeChatMessageMatchContent(getMessageText(liveAssistantMessage))
        ? trailingMessage
        : undefined);
    if (persistedLiveMessage) {
      const persistedText = getMessageText(persistedLiveMessage).trim();
      // While a message is still streaming the live copy is the fresher one,
      // unless the persisted copy is strictly ahead of it (a snapshot that
      // already contains text the live stream has not caught up with yet).
      const liveExtendsPersisted = liveText.startsWith(persistedText);
      const persistedExtendsLive = persistedText.startsWith(liveText);
      if (
        !liveMessageState?.terminalMessageIds.includes(liveAssistantMessage.id) &&
        liveAssistantMessage.role !== 'user' &&
        liveText !== persistedText &&
        (liveExtendsPersisted || !persistedExtendsLive)
      ) {
        messages = messages.map((message) =>
          message === persistedLiveMessage
            ? ({
                ...message,
                ...(message.role === 'activity'
                  ? { content: { ...message.content, text: liveText } }
                  : { content: liveText }),
                parts: liveAssistantMessage.parts ?? message.parts,
              } as ChatMessage)
            : message,
        );
      }
      continue;
    } else {
      messages = [
        ...messages,
        {
          ...liveAssistantMessage,
          createdAt: liveAssistantMessage.createdAt || now(),
        },
      ];
    }
  }
  return {
    messages,
    items: buildTranscriptDisplayItems(messages),
    hiddenInheritedMessageCount: inherited.hiddenInheritedMessageCount,
  };
}

/**
 * A tool invocation is worth showing the moment it starts, before it has any
 * output, so a message that only carries tool activity is not empty.
 */
function carriesToolActivity(message: ChatMessage): boolean {
  if (message.toolMeta) return true;
  return message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0;
}

function dedupeTransientUserMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message, index) => {
    if (!isTransientUserMessage(message)) return true;
    const content = normalizeChatMessageMatchContent(getMessageText(message));
    if (!content) return true;
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
