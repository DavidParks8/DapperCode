import type { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { useEffect, useRef } from 'react';
import {
  ACTIVE_CHAT_SYNC_INTERVAL_MS,
  BACKGROUND_CHAT_SYNC_INTERVAL_MS,
  IDLE_CHAT_SYNC_INTERVAL_MS,
  RUN_WATCHDOG_MS,
  didAssistantMessageProgress,
  hasRecentUnansweredUserTurn,
  isChatLikelyRunning,
} from '../../helpers/helpers';

type ChatSyncApi = Pick<HostBridgeApiClient, 'getChat' | 'readThreadQueue' | 'readThreadSchedules'>;

export interface ChatSyncAssessment {
  terminal: boolean;
  shouldShowRunning: boolean;
  shouldRefreshWatchdog: boolean;
  watchdogDurationMs: number;
}

export function assessChatSync(
  previous: Chat | null,
  latest: Chat,
  watchdogActive: boolean,
): ChatSyncAssessment {
  const hasTerminalStatus = latest.status === 'complete' || latest.status === 'error';
  const pendingUserMessage =
    !hasTerminalStatus && !latest.historyRecoveryError && hasRecentUnansweredUserTurn(latest);
  // An idle snapshot that already answers the latest prompt is authoritative. Treating the
  // newly arrived answer as streaming progress re-armed the watchdog after the run had ended.
  const terminal = hasTerminalStatus || (latest.status === 'idle' && !pendingUserMessage);
  const assistantProgress = !terminal && didAssistantMessageProgress(previous, latest);
  const runningFromChat = isChatLikelyRunning(latest) || assistantProgress || pendingUserMessage;
  return {
    terminal,
    shouldShowRunning: !terminal && (runningFromChat || watchdogActive),
    shouldRefreshWatchdog: !terminal && runningFromChat,
    watchdogDurationMs:
      assistantProgress && !isChatLikelyRunning(latest)
        ? Math.floor(RUN_WATCHDOG_MS / 4)
        : RUN_WATCHDOG_MS,
  };
}

export function getChatSyncInterval(appActive: boolean, turnActive: boolean): number {
  if (!appActive) {
    return BACKGROUND_CHAT_SYNC_INTERVAL_MS;
  }
  return turnActive ? ACTIVE_CHAT_SYNC_INTERVAL_MS : IDLE_CHAT_SYNC_INTERVAL_MS;
}

export class ChatSyncController {
  constructor(private readonly api: ChatSyncApi) {}

  load(threadId: string): Promise<Chat> {
    return this.api.getChat(threadId, { forceRefresh: true });
  }

  poll(threadId: string): Promise<Chat> {
    return this.api.getChat(threadId);
  }

  readQueue(threadId: string) {
    return this.api.readThreadQueue(threadId);
  }

  readSchedules(threadId: string) {
    return this.api.readThreadSchedules(threadId);
  }
}

export function useChatSynchronization({
  controller,
  threadId,
  paused,
  getPrevious,
  isWatchdogActive,
  isAppActive,
  isTurnActive,
  onSnapshot,
  onError,
}: {
  controller: ChatSyncController;
  threadId: string | null;
  paused: boolean;
  getPrevious: () => Chat | null;
  isWatchdogActive: () => boolean;
  isAppActive: () => boolean;
  isTurnActive: () => boolean;
  onSnapshot: (chat: Chat, assessment: ChatSyncAssessment) => void;
  onError?: (error: unknown) => void;
}): void {
  const callbacksRef = useRef({
    getPrevious,
    isWatchdogActive,
    isAppActive,
    isTurnActive,
    onSnapshot,
    onError,
  });
  callbacksRef.current = {
    getPrevious,
    isWatchdogActive,
    isAppActive,
    isTurnActive,
    onSnapshot,
    onError,
  };

  useEffect(() => {
    if (!threadId) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sync = async () => {
      if (paused || !callbacksRef.current.isAppActive()) {
        return;
      }
      try {
        const latest = await controller.poll(threadId);
        if (stopped) {
          return;
        }
        const callbacks = callbacksRef.current;
        callbacks.onSnapshot(
          latest,
          assessChatSync(callbacks.getPrevious(), latest, callbacks.isWatchdogActive()),
        );
      } catch (error) {
        if (!stopped) {
          callbacksRef.current.onError?.(error);
        }
      }
    };

    const schedule = () => {
      if (stopped) {
        return;
      }
      const callbacks = callbacksRef.current;
      timer = setTimeout(
        () => {
          void sync().finally(schedule);
        },
        getChatSyncInterval(callbacks.isAppActive(), callbacks.isTurnActive()),
      );
    };

    void sync();
    schedule();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [controller, paused, threadId]);
}
