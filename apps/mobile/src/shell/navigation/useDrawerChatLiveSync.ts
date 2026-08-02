import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import {
  DRAWER_EVENT_REFRESH_DEBOUNCE_MS,
  DRAWER_REFRESH_CONNECTED_MS,
  DRAWER_REFRESH_DISCONNECTED_MS,
  drawerEventRequiresRefresh,
  readDeletedThreadId,
} from '@shell/navigation/drawerChatLoadingConfig';
import {
  pruneStaleDrawerRunIndicators,
  updateDrawerRunIndicatorsForEvent,
  type DrawerRunIndicatorMap,
} from '@shell/navigation/drawerRuntimeIndicators';

interface DrawerChatLiveSyncOptions {
  active: boolean;
  onThreadDeleted: (threadId: string) => void;
  scheduleLoadChats: (delay?: number, forceRefresh?: boolean) => void;
  setRunIndicators: Dispatch<SetStateAction<DrawerRunIndicatorMap>>;
  setWsConnected: Dispatch<SetStateAction<boolean>>;
  ws: HostBridgeWsClient;
  wsConnected: boolean;
}

export interface DrawerChatLiveSyncControls {
  /**
   * Restarts the periodic chat-list poll timer so its next tick lands `delay` ms from now instead
   * of whenever it was already going to fire, and schedules an expedited load through the same
   * `scheduleLoadChats` debounce the timer itself uses. Callers (e.g. an AppState foreground
   * handler) should call this instead of issuing their own fetch, so a foreground resume never
   * races the poll timer into a second, competing request right on top of a WebSocket resume.
   */
  resetPollTimer: (delay?: number, forceRefresh?: boolean) => void;
}

export function useDrawerChatLiveSync({
  active,
  onThreadDeleted,
  scheduleLoadChats,
  setRunIndicators,
  setWsConnected,
  ws,
  wsConnected,
}: DrawerChatLiveSyncOptions): DrawerChatLiveSyncControls {
  useEffect(() => {
    return ws.onEvent((event) => {
      if (event.method === 'bridge/events/snapshotRequired') {
        setRunIndicators({});
        scheduleLoadChats(0, true);
        return;
      }

      const deletedThreadId = readDeletedThreadId(event);
      if (deletedThreadId) {
        onThreadDeleted(deletedThreadId);
      }

      setRunIndicators((previous) => updateDrawerRunIndicatorsForEvent(previous, event));
      if (drawerEventRequiresRefresh(event)) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [onThreadDeleted, scheduleLoadChats, setRunIndicators, ws]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      setWsConnected(connected);
      if (connected) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, setWsConnected, ws]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRunIndicators((previous) => pruneStaleDrawerRunIndicators(previous));
    }, 5000);
    return () => clearInterval(timer);
  }, [setRunIndicators]);

  const wsConnectedRef = useRef(wsConnected);
  useEffect(() => {
    wsConnectedRef.current = wsConnected;
  }, [wsConnected]);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // A recursive setTimeout (rather than setInterval) so an external reset can cancel exactly the
  // pending tick and requeue a fresh one, without leaving a second timer running alongside it.
  const schedulePoll = useCallback(
    (delay: number) => {
      clearPollTimer();
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        scheduleLoadChats();
        schedulePoll(
          wsConnectedRef.current ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS,
        );
      }, delay);
    },
    [clearPollTimer, scheduleLoadChats],
  );

  useEffect(() => {
    if (!active) {
      clearPollTimer();
      return;
    }
    schedulePoll(wsConnected ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS);
    return clearPollTimer;
  }, [active, clearPollTimer, schedulePoll, wsConnected]);

  const resetPollTimer = useCallback(
    (delay: number = DRAWER_EVENT_REFRESH_DEBOUNCE_MS, forceRefresh = true) => {
      if (!active) {
        return;
      }
      scheduleLoadChats(delay, forceRefresh);
      schedulePoll(
        wsConnectedRef.current ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS,
      );
    },
    [active, scheduleLoadChats, schedulePoll],
  );

  return { resetPollTimer };
}
