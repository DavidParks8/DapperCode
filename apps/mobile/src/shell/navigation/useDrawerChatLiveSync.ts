import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { AppState } from 'react-native';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import {
  DRAWER_EVENT_REFRESH_DEBOUNCE_MS,
  DRAWER_REFRESH_CONNECTED_MS,
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
  cancelMaintenanceWork: () => void;
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
  cancelMaintenanceWork,
  onThreadDeleted,
  scheduleLoadChats,
  setRunIndicators,
  setWsConnected,
  ws,
  wsConnected,
}: DrawerChatLiveSyncOptions): DrawerChatLiveSyncControls {
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const activeRef = useRef(active);
  const appActiveRef = useRef(appActive);
  const wsConnectedRef = useRef(wsConnected);
  activeRef.current = active;
  wsConnectedRef.current = wsConnected;
  const maintenanceActive = active && appActive && wsConnected;
  const isMaintenanceActive = useCallback(
    () => activeRef.current && appActiveRef.current && wsConnectedRef.current,
    [],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const nextActive = state === 'active';
      appActiveRef.current = nextActive;
      if (!nextActive) {
        cancelMaintenanceWork();
      }
      setAppActive(nextActive);
    });
    return () => subscription.remove();
  }, [cancelMaintenanceWork]);

  useEffect(() => {
    return ws.onEvent((event) => {
      if (event.method === 'bridge/events/snapshotRequired') {
        setRunIndicators({});
        if (isMaintenanceActive()) {
          scheduleLoadChats(0, true);
        }
        return;
      }

      const deletedThreadId = readDeletedThreadId(event);
      if (deletedThreadId) {
        onThreadDeleted(deletedThreadId);
      }

      setRunIndicators((previous) => updateDrawerRunIndicatorsForEvent(previous, event));
      if (isMaintenanceActive() && drawerEventRequiresRefresh(event)) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [isMaintenanceActive, onThreadDeleted, scheduleLoadChats, setRunIndicators, ws]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      wsConnectedRef.current = connected;
      setWsConnected(connected);
      if (!connected) {
        cancelMaintenanceWork();
      } else if (activeRef.current && appActiveRef.current) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [cancelMaintenanceWork, scheduleLoadChats, setWsConnected, ws]);

  useEffect(() => {
    if (!maintenanceActive) {
      return;
    }
    const timer = setInterval(() => {
      if (!isMaintenanceActive()) {
        return;
      }
      setRunIndicators((previous) => pruneStaleDrawerRunIndicators(previous));
    }, 5000);
    return () => clearInterval(timer);
  }, [isMaintenanceActive, maintenanceActive, setRunIndicators]);

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
        if (!isMaintenanceActive()) {
          return;
        }
        scheduleLoadChats();
        schedulePoll(DRAWER_REFRESH_CONNECTED_MS);
      }, delay);
    },
    [clearPollTimer, isMaintenanceActive, scheduleLoadChats],
  );

  useEffect(() => {
    if (!maintenanceActive) {
      clearPollTimer();
      return;
    }
    schedulePoll(DRAWER_REFRESH_CONNECTED_MS);
    return clearPollTimer;
  }, [clearPollTimer, maintenanceActive, schedulePoll]);

  const resetPollTimer = useCallback(
    (delay: number = DRAWER_EVENT_REFRESH_DEBOUNCE_MS, forceRefresh = true) => {
      if (!isMaintenanceActive()) {
        return;
      }
      scheduleLoadChats(delay, forceRefresh);
      schedulePoll(DRAWER_REFRESH_CONNECTED_MS);
    },
    [isMaintenanceActive, scheduleLoadChats, schedulePoll],
  );

  return { resetPollTimer };
}
