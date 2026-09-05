import { reconcileChatTranscript } from '@bridge/mapping/chatReconciliation';
import type { Chat, ChatSummary } from '@bridge/types/types';
import { areChatsEquivalent } from './chatEquivalence';

export function resolveEquivalentChat(previous: Chat, next: Chat): Chat {
  const reconciled = reconcileChatTranscript(previous, next);
  return areChatsEquivalent(previous, reconciled) ? previous : reconciled;
}

export function mergeChatSummaryPreservingMessages(previous: Chat, summary: ChatSummary): Chat {
  const next = { ...previous, ...summary, messages: previous.messages };
  return areChatsEquivalent(previous, next) ? previous : next;
}
