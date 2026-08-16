import { AppState, type AppStateStatus } from 'react-native';

import type { RpcNotification } from '@bridge/types/types';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { PUSH_CANDIDATE_METHOD } from '@bridge/ws/types';
import { isUserPresentAppState } from '@shell/session/appVisibility';
export { PUSH_PRESENCE_METHOD } from '@bridge/ws/types';
export const PUSH_PRESENCE_RENEW_INTERVAL_MS = 10_000;
const PENDING_CANDIDATE_LIMIT = 128;

interface PushCandidate {
  candidateId: string;
  afterEventId: number;
}

interface AppStateSource {
  currentState: AppStateStatus;
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove: () => void };
}

function readPushCandidate(event: RpcNotification): PushCandidate | null {
  const candidateId = event.params?.['candidateId'];
  const afterEventId = event.params?.['afterEventId'];
  if (
    event.method !== PUSH_CANDIDATE_METHOD ||
    typeof candidateId !== 'string' ||
    candidateId.length === 0 ||
    typeof afterEventId !== 'number' ||
    !Number.isSafeInteger(afterEventId) ||
    afterEventId < 0
  ) {
    return null;
  }
  return { candidateId, afterEventId };
}

function rememberPushCandidate(
  pendingCandidates: Map<string, number>,
  candidate: PushCandidate,
): void {
  if (
    !pendingCandidates.has(candidate.candidateId) &&
    pendingCandidates.size >= PENDING_CANDIDATE_LIMIT
  ) {
    const oldestCandidateId = pendingCandidates.keys().next().value;
    if (typeof oldestCandidateId === 'string') {
      pendingCandidates.delete(oldestCandidateId);
    }
  }
  pendingCandidates.set(candidate.candidateId, candidate.afterEventId);
}

export function bindPushForegroundPresence(
  ws: HostBridgeWsClient,
  appState: AppStateSource = AppState,
): () => void {
  let foreground = isUserPresentAppState(appState.currentState);
  let streamId: string | null = null;
  let lastDeliveredEventId = 0;
  const pendingCandidates = new Map<string, number>();
  const publish = () => {
    ws.reportPushPresence(foreground);
  };
  const flushObservedCandidates = () => {
    if (!foreground || !ws.isConnected) {
      return;
    }
    for (const [candidateId, afterEventId] of pendingCandidates) {
      if (afterEventId <= lastDeliveredEventId) {
        ws.reportPushObservation(candidateId);
        pendingCandidates.delete(candidateId);
      }
    }
  };

  if (ws.isConnected) {
    publish();
  }
  const unsubscribeStatus = ws.onStatus((connected) => {
    if (!connected) {
      pendingCandidates.clear();
      return;
    }
    publish();
  });
  const unsubscribeBeforeDisconnect = ws.onBeforeDisconnect(() => {
    pendingCandidates.clear();
    ws.reportPushPresence(false);
  });
  const unsubscribeEvents = ws.onEvent((event) => {
    if (event.streamId && event.streamId !== streamId) {
      streamId = event.streamId;
      lastDeliveredEventId = 0;
      pendingCandidates.clear();
    }
    if (typeof event.eventId === 'number' && event.eventId > lastDeliveredEventId) {
      lastDeliveredEventId = event.eventId;
    }
    if (event.method === 'bridge/events/snapshotRequired') {
      pendingCandidates.clear();
      return;
    }
    if (!foreground || !ws.isConnected) {
      return;
    }
    const candidate = readPushCandidate(event);
    if (candidate) {
      rememberPushCandidate(pendingCandidates, candidate);
    }
    flushObservedCandidates();
  });
  const subscription = appState.addEventListener('change', (state) => {
    foreground = isUserPresentAppState(state);
    if (!foreground) {
      pendingCandidates.clear();
    }
    if (ws.isConnected) {
      publish();
    }
    flushObservedCandidates();
  });
  const renewalTimer = setInterval(() => {
    if (foreground && ws.isConnected) {
      publish();
    }
  }, PUSH_PRESENCE_RENEW_INTERVAL_MS);

  return () => {
    if (ws.isConnected) {
      ws.reportPushPresence(false);
    }
    pendingCandidates.clear();
    clearInterval(renewalTimer);
    subscription.remove();
    unsubscribeEvents();
    unsubscribeBeforeDisconnect();
    unsubscribeStatus();
  };
}
