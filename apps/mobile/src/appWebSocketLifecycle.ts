import { AppState, type AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from './api/ws';

interface AppStateSource {
  currentState: AppStateStatus;
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove: () => void };
}

export function bindAppWebSocketLifecycle(
  ws: HostBridgeWsClient,
  appState: AppStateSource = AppState,
): () => void {
  const syncConnection = (state: AppStateStatus) => {
    if (state === 'active') {
      ws.connect();
      return;
    }
    ws.disconnect();
  };

  syncConnection(appState.currentState);
  const subscription = appState.addEventListener('change', syncConnection);

  return () => {
    subscription.remove();
    ws.disconnect();
  };
}
