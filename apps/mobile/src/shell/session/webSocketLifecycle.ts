import { AppState, type AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { isUserPresentAppState } from '@shell/session/appVisibility';

const BACKGROUND_DISCONNECT_GRACE_MS = 10_000;

interface AppStateSource {
  currentState: AppStateStatus;
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove: () => void };
}

export function bindAppWebSocketLifecycle(
  ws: Pick<HostBridgeWsClient, 'connect' | 'disconnect'>,
  appState: AppStateSource = AppState,
): () => void {
  let currentState = appState.currentState;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelDisconnect = () => {
    if (disconnectTimer !== null) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };
  const syncConnection = (state: AppStateStatus) => {
    const wasUserPresent = isUserPresentAppState(currentState);
    currentState = state;
    if (isUserPresentAppState(state)) {
      cancelDisconnect();
      ws.connect();
      return;
    }
    if (wasUserPresent) {
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        ws.disconnect();
      }, BACKGROUND_DISCONNECT_GRACE_MS);
    }
  };

  if (isUserPresentAppState(currentState)) {
    ws.connect();
  } else {
    ws.disconnect();
  }

  const subscription = appState.addEventListener('change', syncConnection);

  return () => {
    subscription.remove();
    cancelDisconnect();
    ws.disconnect();
  };
}
