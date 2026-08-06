import { useCallback, useMemo, useRef, useState } from 'react';

import type { ChatMessage, ChatStatus } from '@bridge/types/types';
import { forkBoundariesByActionMessageId } from './messages';

const NO_FORK_BOUNDARIES: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * Maps each message that should carry the fork action to the boundary the bridge is asked to fork
 * at, or nothing at all when this conversation cannot be forked.
 *
 * Inherited sub-agent history and transcripts with unreachable earlier turns cannot be forked
 * because the bridge could not reconstruct the conversation the caller can see.
 */
export function useForkBoundaries({
  messages,
  chatStatus,
  parentThreadId,
  unavailableCount,
  supportsConversationFork,
  supportsForkFromResponse,
}: {
  messages: ChatMessage[];
  chatStatus: ChatStatus;
  parentThreadId: string | undefined;
  unavailableCount: number | undefined;
  supportsConversationFork: boolean;
  supportsForkFromResponse: boolean;
}): ReadonlyMap<string, string> {
  return useMemo(() => {
    const enabled = supportsConversationFork && !parentThreadId && (unavailableCount ?? 0) === 0;
    return enabled
      ? forkBoundariesByActionMessageId(messages, chatStatus, {
          fromResponse: supportsForkFromResponse,
        })
      : NO_FORK_BOUNDARIES;
  }, [
    chatStatus,
    messages,
    parentThreadId,
    supportsConversationFork,
    supportsForkFromResponse,
    unavailableCount,
  ]);
}

export function useForkConversationAction(
  onForkConversation?: (messageId: string) => Promise<unknown>,
) {
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const forkInFlightRef = useRef(false);
  const handleForkConversation = useCallback(
    (messageId: string) => {
      if (forkInFlightRef.current || !onForkConversation) {
        return;
      }
      forkInFlightRef.current = true;
      setForkingMessageId(messageId);
      void onForkConversation(messageId)
        .catch(() => undefined)
        .finally(() => {
          forkInFlightRef.current = false;
          setForkingMessageId(null);
        });
    },
    [onForkConversation],
  );
  return { forkingMessageId, handleForkConversation };
}
