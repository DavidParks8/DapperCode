import { AppState, type AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { isUserPresentAppState } from '@shell/session/appVisibility';

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
    if (isUserPresentAppState(state)) {
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
