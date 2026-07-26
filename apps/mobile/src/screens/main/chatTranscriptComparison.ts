import type { Chat } from '../../api/types';
import type { ChatTranscriptViewProps } from './ChatTranscriptView';

export function areChatTranscriptViewPropsEqual(
  previous: ChatTranscriptViewProps,
  next: ChatTranscriptViewProps,
): boolean {
  return (
    areChatsEquivalentForTranscript(previous.chat, next.chat) &&
    areChatsEquivalentForTranscript(previous.parentChat, next.parentChat) &&
    previous.bridgeUrl === next.bridgeUrl &&
    previous.bridgeToken === next.bridgeToken &&
    previous.onOpenLocalPreview === next.onOpenLocalPreview &&
    previous.showToolCalls === next.showToolCalls &&
    previous.agentThreadStatusById === next.agentThreadStatusById &&
    previous.scrollRef === next.scrollRef &&
    previous.inlineChoicesEnabled === next.inlineChoicesEnabled &&
    previous.onInlineOptionSelect === next.onInlineOptionSelect &&
    previous.onPinnedAutoScroll === next.onPinnedAutoScroll &&
    previous.onJumpToLatest === next.onJumpToLatest &&
    previous.onScrollInteractionStart === next.onScrollInteractionStart &&
    previous.autoScrollStateRef === next.autoScrollStateRef &&
    previous.bottomInset === next.bottomInset &&
    previous.liveMessageState === next.liveMessageState &&
    previous.onOpenSubAgentThread === next.onOpenSubAgentThread &&
    previous.continuationState === next.continuationState &&
    previous.onLoadEarlier === next.onLoadEarlier
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
    previous.messages === next.messages
  );
}
