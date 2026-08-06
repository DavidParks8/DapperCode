import type { Chat } from '@bridge/types/types';
import type { ChatTranscriptViewProps } from './ChatTranscriptView';
import type { ActivityState } from '../helpers/helpers';

function areActivitiesEquivalent(
  previous: ActivityState | null | undefined,
  next: ActivityState | null | undefined,
): boolean {
  return (
    previous === next ||
    (previous?.tone === next?.tone &&
      previous?.title === next?.title &&
      previous?.detail === next?.detail)
  );
}

function areTranscriptConnectionPropsEqual(
  previous: ChatTranscriptViewProps,
  next: ChatTranscriptViewProps,
): boolean {
  return previous.bridgeUrl === next.bridgeUrl && previous.bridgeToken === next.bridgeToken;
}

function areTranscriptInteractionPropsEqual(
  previous: ChatTranscriptViewProps,
  next: ChatTranscriptViewProps,
): boolean {
  return (
    previous.onOpenLocalPreview === next.onOpenLocalPreview &&
    previous.onOpenSubAgentThread === next.onOpenSubAgentThread &&
    previous.onInlineOptionSelect === next.onInlineOptionSelect &&
    previous.onPinnedAutoScroll === next.onPinnedAutoScroll &&
    previous.onJumpToLatest === next.onJumpToLatest &&
    previous.onScrollInteractionStart === next.onScrollInteractionStart &&
    previous.onForkConversation === next.onForkConversation &&
    previous.scrollRef === next.scrollRef &&
    previous.autoScrollStateRef === next.autoScrollStateRef
  );
}

function areTranscriptDisplayPropsEqual(
  previous: ChatTranscriptViewProps,
  next: ChatTranscriptViewProps,
): boolean {
  return (
    previous.showToolCalls === next.showToolCalls &&
    previous.agentThreadStatusById === next.agentThreadStatusById &&
    previous.inlineChoicesEnabled === next.inlineChoicesEnabled &&
    previous.bottomInset === next.bottomInset &&
    previous.topInset === next.topInset &&
    previous.liveMessageState === next.liveMessageState &&
    previous.continuationState === next.continuationState &&
    previous.onLoadEarlier === next.onLoadEarlier &&
    previous.scrollRailEnabled === next.scrollRailEnabled &&
    previous.supportsConversationFork === next.supportsConversationFork &&
    previous.supportsForkFromResponse === next.supportsForkFromResponse &&
    areActivitiesEquivalent(previous.activity, next.activity)
  );
}

export function areChatTranscriptViewPropsEqual(
  previous: ChatTranscriptViewProps,
  next: ChatTranscriptViewProps,
): boolean {
  return (
    areChatsEquivalentForTranscript(previous.chat, next.chat) &&
    areChatsEquivalentForTranscript(previous.parentChat, next.parentChat) &&
    areTranscriptConnectionPropsEqual(previous, next) &&
    areTranscriptInteractionPropsEqual(previous, next) &&
    areTranscriptDisplayPropsEqual(previous, next)
  );
}

function areChatsEquivalentForTranscript(previous: Chat | null, next: Chat | null): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    previous.id === next.id &&
    previous.parentThreadId === next.parentThreadId &&
    previous.agentId === next.agentId &&
    previous.status === next.status &&
    previous.statusUpdatedAt === next.statusUpdatedAt &&
    previous.lastRunStartedAt === next.lastRunStartedAt &&
    previous.lastRunFinishedAt === next.lastRunFinishedAt &&
    previous.lastRunDurationMs === next.lastRunDurationMs &&
    previous.messages === next.messages
  );
}
