import { AppState, type AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '@bridge/ws/ws';

export const WORKSPACE_REVALIDATE_DEBOUNCE_MS = 250;

interface AppStateSource {
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove: () => void };
}

export function bindWorkspaceResourcesRevalidation(
  ws: HostBridgeWsClient,
  revalidate: () => void,
  appState: AppStateSource = AppState,
  debounceMs = WORKSPACE_REVALIDATE_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      revalidate();
    }, debounceMs);
  };

  schedule();
  const unsubscribeStatus = ws.onStatus((connected) => {
    if (connected) {
      schedule();
    }
  });
  const appStateSubscription = appState.addEventListener('change', (state) => {
    if (state === 'active') {
      schedule();
    }
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    unsubscribeStatus();
    appStateSubscription.remove();
  };
}
