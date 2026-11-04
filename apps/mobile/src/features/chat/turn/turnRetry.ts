import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Chat } from '@bridge/types/types';
import { activeProfileFeaturesAtom, wsClientAtom } from '@shell/state/bridge/atoms';
import { activityAtom } from '../state/composer';
import { errorAtom, sendingAtom } from '../state/turn';

/** Agent method that continues a chat's last failed turn (profiles with the `turnRetry` feature). */
export const TURN_RETRY_METHOD = 'bridge/turn/retry';

export interface FailedTurnRetry {
  /** The failure to show beside the Retry action. */
  message: string;
  retrying: boolean;
  retry: () => void;
}

/** The shared turn lifecycle a retry settles through, exactly like a sent message. */
export interface TurnRetryLifecycle {
  selectedChatIdRef: { readonly current: string | null };
  registerTurnStarted: (threadId: string, turnId: string) => void;
  handleTurnFailure: (error: unknown) => void;
}

/**
 * The Retry action for a chat whose last turn failed, on agents that can continue a failed turn
 * without the user resending it. Null when there is nothing to retry or the agent can't.
 *
 * A pending retry counts as sending for its own chat, so the composer shows Stop while the agent
 * prepares the turn (an on-device retry may first reload its model). Its outcome only touches the
 * shared turn state while the same profile and chat are still on screen.
 */
export function useFailedTurnRetry(params: {
  selectedChat: Chat | null;
  visibleError: string | null;
  running: boolean;
  lifecycle: TurnRetryLifecycle;
}): FailedTurnRetry | null {
  const { selectedChat, visibleError, running, lifecycle } = params;
  const { turnRetry } = useAtomValue(activeProfileFeaturesAtom);
  const ws = useAtomValue(wsClientAtom);
  const setError = useSetAtom(errorAtom);
  const setActivity = useSetAtom(activityAtom);
  const setSending = useSetAtom(sendingAtom);
  const [retryingThreadId, setRetryingThreadId] = useState<string | null>(null);
  const threadId = selectedChat?.id ?? null;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  // Opening a chat resets sending, so reassert it whenever the retrying chat is on screen.
  useEffect(() => {
    if (retryingThreadId && retryingThreadId === threadId) {
      setSending(true);
    }
  }, [retryingThreadId, setSending, threadId]);

  const retry = useCallback(() => {
    if (!threadId || !ws || retryingThreadId) {
      return;
    }
    const isCurrent = () =>
      wsRef.current === ws && lifecycleRef.current.selectedChatIdRef.current === threadId;
    setRetryingThreadId(threadId);
    setError(null);
    setActivity({ tone: 'running', title: 'Retrying' });
    ws.request<{ turn?: { id?: unknown } }>(TURN_RETRY_METHOD, { threadId })
      .then((result) => {
        const turnId = typeof result?.turn?.id === 'string' ? result.turn.id : null;
        if (turnId && isCurrent()) {
          lifecycleRef.current.registerTurnStarted(threadId, turnId);
        }
      })
      .catch((error: unknown) => {
        // Another chat's failure is not this screen's error; it stays on its own chat.
        if (isCurrent()) {
          lifecycleRef.current.handleTurnFailure(error);
        }
      })
      .finally(() => {
        if (isCurrent()) {
          setSending(false);
        }
        setRetryingThreadId(null);
      });
  }, [retryingThreadId, setActivity, setError, setSending, threadId, ws]);

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
