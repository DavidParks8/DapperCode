import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useState } from 'react';

import type { Chat } from '@bridge/types/types';
import { activeProfileFeaturesAtom, wsClientAtom } from '@shell/state/bridge/atoms';
import { activityAtom } from '../state/composer';
import { errorAtom } from '../state/turn';

/** Agent method that continues a chat's last failed turn (profiles with the `turnRetry` feature). */
export const TURN_RETRY_METHOD = 'bridge/turn/retry';

export interface FailedTurnRetry {
  /** The failure to show beside the Retry action. */
  message: string;
  retrying: boolean;
  retry: () => void;
}

/**
 * The Retry action for a chat whose last turn failed, on agents that can continue a failed turn
 * without the user resending it. Null when there is nothing to retry or the agent can't.
 */
export function useFailedTurnRetry(params: {
  selectedChat: Chat | null;
  visibleError: string | null;
  running: boolean;
}): FailedTurnRetry | null {
  const { selectedChat, visibleError, running } = params;
  const { turnRetry } = useAtomValue(activeProfileFeaturesAtom);
  const ws = useAtomValue(wsClientAtom);
  const setError = useSetAtom(errorAtom);
  const setActivity = useSetAtom(activityAtom);
  const [retryingThreadId, setRetryingThreadId] = useState<string | null>(null);
  const threadId = selectedChat?.id ?? null;

  const retry = useCallback(() => {
    if (!threadId || !ws || retryingThreadId) {
      return;
    }
    setRetryingThreadId(threadId);
    setError(null);
    setActivity({ tone: 'running', title: 'Retrying' });
    ws.request(TURN_RETRY_METHOD, { threadId })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
        setActivity({ tone: 'error', title: 'Turn failed', detail: message });
      })
      .finally(() => setRetryingThreadId(null));
  }, [retryingThreadId, setActivity, setError, threadId, ws]);

  const failed = selectedChat?.status === 'error';
  if (!turnRetry || !threadId || !failed || (running && retryingThreadId === null)) {
    return null;
  }
  return {
    message: visibleError || selectedChat.lastError?.trim() || 'The last turn failed.',
    retrying: retryingThreadId === threadId,
    retry,
  };
}
