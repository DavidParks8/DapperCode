import { useAtomValue } from 'jotai';

import type { HostBridgeApiClient } from '../../api/client';
import type { HostBridgeWsClient } from '../../api/ws';
import { apiClientAtom, wsClientAtom } from './atoms';

/**
 * Screens below the app shell only render once a bridge profile is configured, so the
 * clients are guaranteed to exist there.
 */
export function useBridgeApi(): HostBridgeApiClient {
  const api = useAtomValue(apiClientAtom);
  if (!api) {
    throw new Error('The bridge API client is unavailable.');
  }
  return api;
}

export function useBridgeWs(): HostBridgeWsClient {
  const ws = useAtomValue(wsClientAtom);
  if (!ws) {
    throw new Error('The bridge WebSocket client is unavailable.');
  }
  return ws;
}
