import { activityAtom } from '../../state/mainScreen/composer';
import { threadRuntimeSnapshotsAtom } from '../../state/mainScreen/runtime';
import { useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { PendingApproval, PendingUserInputRequest } from '../../api/types';
import { env } from '../../config';
import {
  type ActivityState,
  type ThreadRuntimeSnapshot,
  appendRunEventHistory,
  isChatLikelyRunning,
} from './mainScreenHelpers';
import { resolveEquivalentChat } from './mainScreenChatState';
import type {
  MainScreenChatHydrationContext,
  MainScreenChatHydrationResult,
} from './mainScreenChatHydration';

export type MainScreenRuntimeWatchdogSyncContext = MainScreenChatHydrationContext &
  MainScreenChatHydrationResult;

export function useMainScreenRuntimeWatchdogSync(context: MainScreenRuntimeWatchdogSyncContext) {
  const {
    api,
    bumpAgentRuntimeRevision,
    bumpRunWatchdog,
    chatIdRef,
    externalStatusFullSyncInFlightRef,
    externalStatusFullSyncNextAllowedAtRef,
    externalStatusFullSyncQueuedThreadRef,
    externalStatusFullSyncTimerRef,
    mergeChatWithPendingOptimisticMessages,
    setSelectedChat,
  } = context;
  const setActivity = useSetAtom(activityAtom);
  const setThreadRuntimeSnapshots = useSetAtom(threadRuntimeSnapshotsAtom);

  const clearExternalStatusFullSync = useCallback(() => {
    const timer = externalStatusFullSyncTimerRef.current;
    if (!timer) {
      externalStatusFullSyncQueuedThreadRef.current = null;
      return;
    }
    clearTimeout(timer);
    externalStatusFullSyncTimerRef.current = null;
    externalStatusFullSyncQueuedThreadRef.current = null;
  }, [externalStatusFullSyncQueuedThreadRef, externalStatusFullSyncTimerRef]);

  const drainExternalStatusFullSyncQueue = useCallback(() => {
    if (externalStatusFullSyncInFlightRef.current) {
      return;
    }

    const queuedThreadId = externalStatusFullSyncQueuedThreadRef.current;
    if (!queuedThreadId) {
      return;
    }

    if (chatIdRef.current !== queuedThreadId) {
      externalStatusFullSyncQueuedThreadRef.current = null;
      return;
    }

    const waitMs = Math.max(0, externalStatusFullSyncNextAllowedAtRef.current - Date.now());
    if (waitMs > 0) {
      if (!externalStatusFullSyncTimerRef.current) {
        externalStatusFullSyncTimerRef.current = setTimeout(() => {
          externalStatusFullSyncTimerRef.current = null;
          drainExternalStatusFullSyncQueue();
        }, waitMs);
      }
      return;
    }

    externalStatusFullSyncQueuedThreadRef.current = null;
    externalStatusFullSyncInFlightRef.current = true;
    externalStatusFullSyncNextAllowedAtRef.current =
      Date.now() + env.externalStatusFullSyncDebounceMs;

    api
      .getChat(queuedThreadId)
      .then((latest) => {
        const resolvedLatest = mergeChatWithPendingOptimisticMessages(latest);
        if (chatIdRef.current !== queuedThreadId) {
          return;
        }
        setSelectedChat((prev) => {
          if (!prev || prev.id !== resolvedLatest.id) {
            return prev;
          }
          return resolveEquivalentChat(prev, resolvedLatest);
        });
        if (isChatLikelyRunning(resolvedLatest)) {
          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' },
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        externalStatusFullSyncInFlightRef.current = false;
        drainExternalStatusFullSyncQueue();
      });
  }, [
    api,
    bumpRunWatchdog,
    chatIdRef,
    externalStatusFullSyncInFlightRef,
    externalStatusFullSyncNextAllowedAtRef,
    externalStatusFullSyncQueuedThreadRef,
    externalStatusFullSyncTimerRef,
    mergeChatWithPendingOptimisticMessages,
    setActivity,
    setSelectedChat,
  ]);

  const scheduleExternalStatusFullSync = useCallback(
    (threadId: string) => {
      if (chatIdRef.current !== threadId) {
        return;
      }
      externalStatusFullSyncQueuedThreadRef.current = threadId;
      drainExternalStatusFullSyncQueue();
    },
    [chatIdRef, drainExternalStatusFullSyncQueue, externalStatusFullSyncQueuedThreadRef],
  );

  useEffect(
    () => () => {
      clearExternalStatusFullSync();
    },
    [clearExternalStatusFullSync],
  );

  const upsertThreadRuntimeSnapshot = useCallback(
    (
      threadId: string,
      updater: (previous: ThreadRuntimeSnapshot) => Partial<ThreadRuntimeSnapshot>,
    ) => {
      if (!threadId) {
        return;
      }

      setThreadRuntimeSnapshots((current) => {
        const previous =
          current[threadId] ??
          ({
            updatedAtMs: Date.now(),
          } as ThreadRuntimeSnapshot);
        return {
          ...current,
          [threadId]: {
            ...previous,
            ...updater(previous),
            updatedAtMs: Date.now(),
          },
        };
      });
    },
    [setThreadRuntimeSnapshots],
  );

  const cacheThreadActivity = useCallback(
    (threadId: string, nextActivity: ActivityState) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({ activity: nextActivity }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadActiveCommand = useCallback(
    (threadId: string, eventType: string, detail: string) => {
      upsertThreadRuntimeSnapshot(threadId, (previous) => {
        const activeCommands = appendRunEventHistory(
          previous.activeCommands ?? [],
          threadId,
          eventType,
          detail,
        );
        return {
          activeCommands,
          latestCommand:
            activeCommands[activeCommands.length - 1] ?? previous.latestCommand ?? null,
        };
      });
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadPendingApproval = useCallback(
    (threadId: string, approval: PendingApproval | null) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        pendingApproval: approval,
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadPendingUserInputRequest = useCallback(
    (threadId: string, request: PendingUserInputRequest | null) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        pendingUserInputRequest: request,
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  return {
    clearExternalStatusFullSync,
    drainExternalStatusFullSyncQueue,
    scheduleExternalStatusFullSync,
    upsertThreadRuntimeSnapshot,
    cacheThreadActivity,
    cacheThreadActiveCommand,
    cacheThreadPendingApproval,
    cacheThreadPendingUserInputRequest,
  };
}

export type MainScreenRuntimeWatchdogSyncResult = ReturnType<
  typeof useMainScreenRuntimeWatchdogSync
>;
