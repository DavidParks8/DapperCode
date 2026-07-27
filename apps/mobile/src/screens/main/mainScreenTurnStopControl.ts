import {
  activeTurnIdAtom,
  creatingAtom,
  errorAtom,
  sendingAtom,
  stoppingTurnAtom,
} from '../../state/mainScreen/turn';
import {
  activityAtom,
  bridgeRecoveryBannerVisibleAtom,
  showDelayedGenericRunningActivityAtom,
} from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type {
  MainScreenReasoningAndInterruptContext,
  MainScreenReasoningAndInterruptResult,
} from './mainScreenReasoningAndInterrupt';

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
    ws,
  } = context;
  const stoppingTurn = useAtomValue(stoppingTurnAtom);
  const setSending = useSetAtom(sendingAtom);
  const setCreating = useSetAtom(creatingAtom);
  const setError = useSetAtom(errorAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setActivity = useSetAtom(activityAtom);
  const setShowDelayedGenericRunningActivity = useSetAtom(showDelayedGenericRunningActivityAtom);
  const setBridgeRecoveryBannerVisible = useSetAtom(bridgeRecoveryBannerVisibleAtom);

  const registerTurnStarted = useCallback(
    (threadId: string, turnId: string) => {
      const currentChatId = chatIdRef.current;
      if (!threadId || !turnId || (currentChatId && currentChatId !== threadId)) {
        return;
      }

      const nowIso = new Date().toISOString();
      setSending(false);
      setCreating(false);
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
    [interruptActiveTurn],
  );

  const handleStopTurn = useCallback(() => {
    if (stoppingTurn) {
      return;
    }

    if (!ws.isConnected) {
      // Nothing can be interrupted without the bridge, so the stop stays local:
      // the disconnected state is surfaced instead of a stop that never resolves.
      stopRequestedRef.current = false;
      setStoppingTurn(false);
      setBridgeRecoveryBannerVisible(true);
      setActivity({
        tone: 'error',
        title: 'Bridge disconnected',
        detail: 'Start the bridge on your computer to continue.',
      });
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

    const threadId = chatIdRef.current;
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
  }, [interruptActiveTurn, interruptLatestTurn, stoppingTurn, ws]);

  return {
    registerTurnStarted,
    handleStopTurn,
  };
}

export type MainScreenTurnStopControlResult = ReturnType<typeof useMainScreenTurnStopControl>;
