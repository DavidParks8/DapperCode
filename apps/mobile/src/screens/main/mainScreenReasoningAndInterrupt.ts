import { activeTurnIdAtom, errorAtom, stoppingTurnAtom } from '../../state/mainScreen/turn';
import { activityAtom } from '../../state/mainScreen/composer';
import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { mergeStreamingDelta, formatLiveReasoningMessage } from './mainScreenHelpers';
import type {
  MainScreenLocalCommandChatContext,
  MainScreenLocalCommandChatResult,
} from './mainScreenLocalCommandChat';

export type MainScreenReasoningAndInterruptContext = MainScreenLocalCommandChatContext &
  MainScreenLocalCommandChatResult;

export function useMainScreenReasoningAndInterrupt(
  context: MainScreenReasoningAndInterruptContext,
) {
  const {
    appendLocalSystemMessage,
    chatIdRef,
    clearRunWatchdog,
    liveReasoningBuffersRef,
    liveReasoningMessageIdsRef,
    schedulePinnedScrollToBottom,
    setSelectedChat,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    turnExecutionController,
  } = context;
  const setError = useSetAtom(errorAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setActivity = useSetAtom(activityAtom);

  const upsertLiveReasoningMessage = useCallback(
    (threadId: string, delta?: string | null) => {
      if (!threadId || chatIdRef.current !== threadId) {
        return;
      }

      const previousBuffer = liveReasoningBuffersRef.current[threadId] ?? '';
      const nextBuffer =
        typeof delta === 'string' && delta.length > 0
          ? mergeStreamingDelta(previousBuffer, delta)
          : previousBuffer;

      if (nextBuffer) {
        liveReasoningBuffersRef.current[threadId] = nextBuffer;
      }

      const createdAt = new Date().toISOString();
      const messageId =
        liveReasoningMessageIdsRef.current[threadId] ??
        `local-reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      liveReasoningMessageIdsRef.current[threadId] = messageId;
      const content = formatLiveReasoningMessage(liveReasoningBuffersRef.current[threadId] ?? '');

      setSelectedChat((prev) => {
        if (!prev || prev.id !== threadId) {
          return prev;
        }

        let found = false;
        const messages = prev.messages.map((message) => {
          if (message.id !== messageId) {
            return message;
          }

          found = true;
          return {
            ...message,
            role: 'reasoning' as const,
            content,
            pending: true,
          };
        });

        return {
          ...prev,
          updatedAt: createdAt,
          statusUpdatedAt: createdAt,
          messages: found
            ? messages
            : [
                ...messages,
                {
                  id: messageId,
                  role: 'reasoning',
                  content,
                  createdAt,
                  pending: true,
                },
              ],
        };
      });

      schedulePinnedScrollToBottom(true);
    },
    [
      chatIdRef,
      liveReasoningBuffersRef,
      liveReasoningMessageIdsRef,
      schedulePinnedScrollToBottom,
      setSelectedChat,
    ],
  );

  const clearLiveReasoningMessage = useCallback(
    (threadId: string | null | undefined) => {
      if (!threadId) {
        return;
      }
      const messageId = liveReasoningMessageIdsRef.current[threadId];
      if (messageId) {
        setSelectedChat((previous) => {
          if (!previous || previous.id !== threadId) {
            return previous;
          }
          let changed = false;
          const messages = previous.messages.map((message) => {
            if (message.id !== messageId || message.pending !== true) {
              return message;
            }
            changed = true;
            return { ...message, pending: false };
          });
          return changed ? { ...previous, messages } : previous;
        });
      }
      delete liveReasoningBuffersRef.current[threadId];
      delete liveReasoningMessageIdsRef.current[threadId];
    },
    [liveReasoningBuffersRef, liveReasoningMessageIdsRef, setSelectedChat],
  );

  const appendStopSystemMessageIfNeeded = useCallback(() => {
    if (stopSystemMessageLoggedRef.current) {
      return;
    }
    stopSystemMessageLoggedRef.current = true;
    appendLocalSystemMessage('Turn stopped by user.');
  }, [appendLocalSystemMessage, stopSystemMessageLoggedRef]);

  const handleTurnFailure = useCallback(
    (error: unknown) => {
      const message = (error as Error).message ?? String(error);
      const normalizedMessage = message.toLowerCase();
      const interruptedByUser =
        stopRequestedRef.current &&
        (normalizedMessage.includes('turn aborted') || normalizedMessage.includes('interrupted'));

      if (interruptedByUser) {
        setError(null);
        appendStopSystemMessageIfNeeded();
        setActivity({
          tone: 'complete',
          title: 'Turn stopped',
        });
      } else {
        setError(message);
        setActivity({
          tone: 'error',
          title: 'Turn failed',
          detail: message,
        });
      }

      setActiveTurnId(null);
      setStoppingTurn(false);
      stopRequestedRef.current = interruptedByUser;
      clearRunWatchdog();
    },
    [
      appendStopSystemMessageIfNeeded,
      clearRunWatchdog,
      setActiveTurnId,
      setActivity,
      setError,
      setStoppingTurn,
      stopRequestedRef,
    ],
  );

  const interruptActiveTurn = useCallback(
    async (threadId: string, turnId: string) => {
      try {
        await turnExecutionController.interrupt(threadId, turnId);
        setError(null);
        setActivity({
          tone: 'running',
          title: 'Stopping turn',
        });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        setError(message);
        setActivity({
          tone: 'error',
          title: 'Failed to stop turn',
          detail: message,
        });
        setStoppingTurn(false);
        stopRequestedRef.current = false;
      }
    },
    [setActivity, setError, setStoppingTurn, stopRequestedRef, turnExecutionController],
  );

  const interruptLatestTurn = useCallback(
    async (threadId: string) => {
      try {
        const interruptedTurnId = await turnExecutionController.interrupt(threadId);
        if (interruptedTurnId) {
          setActiveTurnId(interruptedTurnId);
          setError(null);
          setActivity({
            tone: 'running',
            title: 'Stopping turn',
          });
          return;
        }

        setStoppingTurn(false);
        stopRequestedRef.current = false;
        setActivity({
          tone: 'idle',
          title: 'No active turn found',
        });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        setError(message);
        setActivity({
          tone: 'error',
          title: 'Failed to stop turn',
          detail: message,
        });
        setStoppingTurn(false);
        stopRequestedRef.current = false;
      }
    },
    [
      setActiveTurnId,
      setActivity,
      setError,
      setStoppingTurn,
      stopRequestedRef,
      turnExecutionController,
    ],
  );

  return {
    upsertLiveReasoningMessage,
    clearLiveReasoningMessage,
    appendStopSystemMessageIfNeeded,
    handleTurnFailure,
    interruptActiveTurn,
    interruptLatestTurn,
  };
}

export type MainScreenReasoningAndInterruptResult = ReturnType<
  typeof useMainScreenReasoningAndInterrupt
>;
