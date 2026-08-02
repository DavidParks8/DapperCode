import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
} from '@bridge/types/types';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { HostBridgeWsClient } from '@bridge/ws/ws';

const ATTENTION_REQUEST_EVENT_METHODS = new Set([
  'bridge/approval.requested',
  'bridge/approval.resolved',
  'bridge/userInput.requested',
  'bridge/userInput.resolved',
  'bridge/events/snapshotRequired',
]);

/**
 * A burst of approval/user-input events (e.g. several requests resolving back to back) would
 * otherwise trigger one refresh per event. Coalescing them behind a short debounce keeps the
 * fetch count proportional to the burst instead of the event count, while staying prompt enough
 * that a lone event still refreshes almost immediately.
 */
const ATTENTION_EVENT_REFRESH_DEBOUNCE_MS = 200;

export function useDrawerAttentionRequests(
  api: HostBridgeApiClient,
  ws: HostBridgeWsClient,
  active: boolean,
) {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [pendingUserInputs, setPendingUserInputs] = useState<PendingUserInputRequest[]>([]);
  const [attentionRequestError, setAttentionRequestError] = useState<string | null>(null);
  const [refreshingAttentionRequests, setRefreshingAttentionRequests] = useState(false);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  const scheduledRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const clearScheduledRefresh = useCallback(() => {
    if (scheduledRefreshRef.current) {
      clearTimeout(scheduledRefreshRef.current);
      scheduledRefreshRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      refreshQueuedRef.current = false;
      clearScheduledRefresh();
    };
  }, [clearScheduledRefresh]);

  const refreshAttentionRequests = useCallback((): Promise<void> => {
    if (!activeRef.current || !mountedRef.current) {
      return Promise.resolve();
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return refreshInFlightRef.current;
    }

    setRefreshingAttentionRequests(true);
    const request = Promise.allSettled([
      Promise.resolve().then(() => api.listApprovals()),
      Promise.resolve().then(() => api.listPendingUserInputs()),
    ])
      .then(([approvalResult, userInputResult]) => {
        if (!mountedRef.current || !activeRef.current) {
          return;
        }
        if (approvalResult.status === 'fulfilled') {
          setPendingApprovals(approvalResult.value);
        }
        if (userInputResult.status === 'fulfilled') {
          setPendingUserInputs(userInputResult.value);
        }
        if (approvalResult.status === 'rejected' && userInputResult.status === 'rejected') {
          setAttentionRequestError('Could not refresh pending requests.');
        } else if (approvalResult.status === 'rejected') {
          setAttentionRequestError('Could not refresh pending approvals.');
        } else if (userInputResult.status === 'rejected') {
          setAttentionRequestError('Could not refresh pending input requests.');
        } else {
          setAttentionRequestError(null);
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRefreshingAttentionRequests(false);
        }
        refreshInFlightRef.current = null;
        const shouldRefreshAgain = refreshQueuedRef.current;
        refreshQueuedRef.current = false;
        if (shouldRefreshAgain && activeRef.current && mountedRef.current) {
          void refreshAttentionRequests();
        }
      });
    refreshInFlightRef.current = request;
    return request;
  }, [api]);

  const scheduleAttentionRefresh = useCallback(
    (delay: number = ATTENTION_EVENT_REFRESH_DEBOUNCE_MS) => {
      if (!activeRef.current || !mountedRef.current) {
        return;
      }
      if (scheduledRefreshRef.current) {
        clearTimeout(scheduledRefreshRef.current);
      }
      scheduledRefreshRef.current = setTimeout(() => {
        scheduledRefreshRef.current = null;
        void refreshAttentionRequests();
      }, delay);
    },
    [refreshAttentionRequests],
  );

  useEffect(() => {
    if (active) {
      void refreshAttentionRequests();
    } else {
      clearScheduledRefresh();
    }
  }, [active, clearScheduledRefresh, refreshAttentionRequests]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return ws.onEvent((event: RpcNotification) => {
      if (ATTENTION_REQUEST_EVENT_METHODS.has(event.method)) {
        scheduleAttentionRefresh();
      }
    });
  }, [active, scheduleAttentionRefresh, ws]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return ws.onStatus((connected) => {
      if (connected) {
        void refreshAttentionRequests();
      }
    });
  }, [active, refreshAttentionRequests, ws]);

  return {
    pendingApprovals,
    pendingUserInputs,
    attentionRequestError,
    refreshingAttentionRequests,
    refreshAttentionRequests,
  };
}
