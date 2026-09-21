import { activeTurnIdAtom, errorAtom, sendingAtom, stoppingTurnAtom } from '../state/turn';
import { activityAtom, showDelayedGenericRunningActivityAtom } from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { isPendingChatId } from '@shell/session/interruptedChatCreation';
import type {
  MainScreenReasoningAndInterruptContext,
  MainScreenReasoningAndInterruptResult,
} from './reasoningAndInterrupt';

export type MainScreenTurnStopControlContext = MainScreenReasoningAndInterruptContext &
  MainScreenReasoningAndInterruptResult;

export function useMainScreenTurnStopControl(context: MainScreenTurnStopControlContext) {
  const {
    activeTurnIdRef,
    chatIdRef,
    interruptActiveTurn,
    interruptLatestTurn,
    setSelectedChat,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
  } = context;
  const stoppingTurn = useAtomValue(stoppingTurnAtom);
  const setSending = useSetAtom(sendingAtom);
  const setError = useSetAtom(errorAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setActivity = useSetAtom(activityAtom);
  const setShowDelayedGenericRunningActivity = useSetAtom(showDelayedGenericRunningActivityAtom);

  const registerTurnStarted = useCallback(
    (threadId: string, turnId: string) => {
      const currentChatId = chatIdRef.current;
      if (!threadId || !turnId || (currentChatId && currentChatId !== threadId)) {
        return;
      }

      const nowIso = new Date().toISOString();
      setSending(false);
      setActiveTurnId(turnId);
      setActivity({ tone: 'running', title: 'Working' });
      setShowDelayedGenericRunningActivity(true);
      setSelectedChat((prev) => {
        if (!prev || prev.id !== threadId) {
          return prev;
        }

        return {
          ...prev,
          status: 'running',
          updatedAt: nowIso,
          statusUpdatedAt: nowIso,
          lastError: undefined,
        };
      });
      if (stopRequestedRef.current) {
        void interruptActiveTurn(threadId, turnId);
      }
    },
    [
      chatIdRef,
      interruptActiveTurn,
      setActiveTurnId,
      setActivity,
      setSelectedChat,
      setSending,
      setShowDelayedGenericRunningActivity,
      stopRequestedRef,
    ],
  );

  const handleStopTurn = useCallback(() => {
    if (stoppingTurn) {
      return;
    }

    const threadId = chatIdRef.current;
    if (isPendingChatId(threadId)) {
      return;
    }

    stopRequestedRef.current = true;
    stopSystemMessageLoggedRef.current = false;
    setStoppingTurn(true);
    setError(null);
    setActivity({
      tone: 'running',
      title: 'Stopping turn',
    });

    const turnId = activeTurnIdRef.current;
    if (threadId && turnId) {
      void interruptActiveTurn(threadId, turnId);
      return;
    }

    if (threadId) {
      void interruptLatestTurn(threadId);
      return;
    }

    setStoppingTurn(false);
    stopRequestedRef.current = false;
    setActivity({
      tone: 'idle',
      title: 'No active turn found',
    });
  }, [
    activeTurnIdRef,
    chatIdRef,
    interruptActiveTurn,
    interruptLatestTurn,
    setActivity,
    setError,
    setStoppingTurn,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    stoppingTurn,
  ]);

  return {
    registerTurnStarted,
    handleStopTurn,
  };
}

export type MainScreenTurnStopControlResult = ReturnType<typeof useMainScreenTurnStopControl>;
