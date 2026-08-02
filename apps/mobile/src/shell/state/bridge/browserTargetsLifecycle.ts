import { AppState, type AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '@bridge/ws/ws';

interface AppStateSource {
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove: () => void };
}

export function bindBrowserTargetRevalidation(
  ws: HostBridgeWsClient | null,
  revalidate: () => void,
  appState: AppStateSource = AppState,
): () => void {
  const unsubscribeStatus =
    ws?.onStatus((connected) => {
      if (connected) {
        revalidate();
      }
    }) ?? null;
  const appStateSubscription = appState.addEventListener('change', (state) => {
    if (state === 'active' && (!ws || ws.isConnected)) {
      revalidate();
    }
  });

  return () => {
    unsubscribeStatus?.();
    appStateSubscription.remove();
  };
}
