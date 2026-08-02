import { useCallback, useEffect } from 'react';
import type { BridgeUiSurface } from '../../api/types';
import { readNonNegativeIntegerLike, toRecord } from '../../runtimeValidation';
import {
  type ActivePlanState,
  type ThreadContextUsage,
  RUN_WATCHDOG_MS,
  type ChatModelPreference,
} from './mainScreenHelpers';
import type {
  MainScreenLocalTranscriptActionsContext,
  MainScreenLocalTranscriptActionsResult,
} from './mainScreenLocalTranscriptActions';

export type MainScreenThreadSnapshotStoreContext = MainScreenLocalTranscriptActionsContext &
  MainScreenLocalTranscriptActionsResult;

function firstRecord(
  candidates: Array<Record<string, unknown> | null | undefined>,
): Record<string, unknown> | null {
  for (const candidate of candidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function readFirstNonNegativeIntegerLike(values: unknown[]): number | null {
  for (const value of values) {
    const parsedValue = readNonNegativeIntegerLike(value);
    if (parsedValue !== null) {
      return parsedValue;
    }
  }

  return null;
}

function resolveTokenUsageRecord(
  record: Record<string, unknown>,
  infoRecord: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return firstRecord([
    toRecord(record['tokenUsage']),
    toRecord(record['token_usage']),
    toRecord(infoRecord?.['tokenUsage']),
    toRecord(infoRecord?.['token_usage']),
  ]);
}

function resolveTokenWindowRecord(
  tokenUsageRecord: Record<string, unknown> | null,
  infoRecord: Record<string, unknown> | null,
  key: 'total' | 'last',
): Record<string, unknown> | null {
  const snakeCaseKey = key === 'total' ? 'total_token_usage' : 'last_token_usage';
  const camelCaseKey = key === 'total' ? 'totalTokenUsage' : 'lastTokenUsage';

  return firstRecord([
    toRecord(tokenUsageRecord?.[key]),
    toRecord(infoRecord?.[snakeCaseKey]),
    toRecord(infoRecord?.[camelCaseKey]),
  ]);
}

function hasThreadContextUsage(
  totalTokens: number | null,
  modelContextWindow: number | null,
): boolean {
  return totalTokens !== null || modelContextWindow !== null;
}

function parseThreadContextUsage(value: unknown): ThreadContextUsage | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const turnRecord = toRecord(record['turn']);
  const infoRecord = toRecord(record['info']);
  const tokenUsageRecord = resolveTokenUsageRecord(record, infoRecord);
  const totalRecord = resolveTokenWindowRecord(tokenUsageRecord, infoRecord, 'total');
  const lastRecord = resolveTokenWindowRecord(tokenUsageRecord, infoRecord, 'last');
  const totalTokens = readFirstNonNegativeIntegerLike([
    totalRecord?.['totalTokens'],
    totalRecord?.['total_tokens'],
  ]);
  const lastTokens =
    readFirstNonNegativeIntegerLike([lastRecord?.['totalTokens'], lastRecord?.['total_tokens']]) ??
    (totalTokens !== null ? 0 : null);
  const modelContextWindow = readFirstNonNegativeIntegerLike([
    record['modelContextWindow'],
    record['model_context_window'],
    turnRecord?.['modelContextWindow'],
    turnRecord?.['model_context_window'],
    tokenUsageRecord?.['modelContextWindow'],
    tokenUsageRecord?.['model_context_window'],
    infoRecord?.['modelContextWindow'],
    infoRecord?.['model_context_window'],
  ]);

  if (!hasThreadContextUsage(totalTokens, modelContextWindow)) {
    return null;
  }

  return {
    totalTokens,
    lastTokens,
    modelContextWindow,
    updatedAtMs: Date.now(),
  };
}

export function useMainScreenThreadSnapshotStore(context: MainScreenThreadSnapshotStoreContext) {
  const {
    api,
    bridgeUiSurfacePersistenceTimeoutRef,
    parentChatCacheRef,
    persistenceController,
    runWatchdogTimerRef,
    runWatchdogUntilRef,
    selectedChat,
    setRunWatchdogNow,
    setSelectedParentChat,
  } = context;

  useEffect(() => {
    const parentThreadId = selectedChat?.parentThreadId?.trim();
    if (!parentThreadId) {
      setSelectedParentChat(null);
      return;
    }

    // Stale-while-revalidate: show the cached parent immediately (if we have
    // one) so renamed/deleted parents don't blank useful stale data, but
    // always revalidate in the background so renames eventually reconcile.
    const cachedParentChat = parentChatCacheRef.current[parentThreadId];
    if (cachedParentChat) {
      setSelectedParentChat(cachedParentChat);
    }

    let cancelled = false;

    api
      .getChat(parentThreadId)
      .then((parentChat) => {
        parentChatCacheRef.current[parentThreadId] = parentChat;
        if (!cancelled) {
          setSelectedParentChat(parentChat);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        // A failed revalidation (e.g. transient network error) shouldn't blank
        // out stale-but-useful cached data. Only clear the parent when we had
        // nothing cached to fall back on.
        if (!cachedParentChat) {
          setSelectedParentChat(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    parentChatCacheRef,
    selectedChat?.id,
    selectedChat?.parentThreadId,
    setSelectedParentChat,
  ]);

  const scheduleRunWatchdogExpiry = useCallback(
    (deadlineMs: number) => {
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }

      const delayMs = deadlineMs - Date.now();
      if (delayMs <= 0) {
        return;
      }

      runWatchdogTimerRef.current = setTimeout(() => {
        runWatchdogTimerRef.current = null;
        setRunWatchdogNow(Date.now());
      }, delayMs + 16);
    },
    [runWatchdogTimerRef, setRunWatchdogNow],
  );

  const bumpRunWatchdog = useCallback(
    (durationMs = RUN_WATCHDOG_MS) => {
      const deadlineMs = Math.max(runWatchdogUntilRef.current, Date.now() + durationMs);
      runWatchdogUntilRef.current = deadlineMs;
      setRunWatchdogNow(Date.now());
      scheduleRunWatchdogExpiry(deadlineMs);
    },
    [runWatchdogUntilRef, scheduleRunWatchdogExpiry, setRunWatchdogNow],
  );

  const clearRunWatchdog = useCallback(() => {
    runWatchdogUntilRef.current = 0;
    const existingTimer = runWatchdogTimerRef.current;
    if (existingTimer) {
      clearTimeout(existingTimer);
      runWatchdogTimerRef.current = null;
    }
    setRunWatchdogNow(Date.now());
  }, [runWatchdogTimerRef, runWatchdogUntilRef, setRunWatchdogNow]);

  useEffect(() => {
    return () => {
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }
    };
  }, [runWatchdogTimerRef]);

  const readThreadContextUsage = useCallback((value: unknown): ThreadContextUsage | null => {
    return parseThreadContextUsage(value);
  }, []);

  const saveChatModelPreferences = useCallback(
    (nextPreferences: Record<string, ChatModelPreference>) =>
      persistenceController.saveModelPreferences(nextPreferences).catch(() => undefined),
    [persistenceController],
  );

  const saveChatPlanSnapshots = useCallback(
    (nextSnapshots: Record<string, ActivePlanState>) =>
      persistenceController.savePlanSnapshots(nextSnapshots),
    [persistenceController],
  );

  const saveBridgeUiSurfaceSnapshots = useCallback(
    (nextSnapshots: Record<string, BridgeUiSurface[]>) =>
      persistenceController.saveBridgeUiSurfaces(nextSnapshots),
    [persistenceController],
  );

  const scheduleBridgeUiSurfaceSnapshotsPersist = useCallback(
    (nextSnapshots: Record<string, BridgeUiSurface[]>) => {
      const existingTimer = bridgeUiSurfacePersistenceTimeoutRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      bridgeUiSurfacePersistenceTimeoutRef.current = setTimeout(() => {
        bridgeUiSurfacePersistenceTimeoutRef.current = null;
        void saveBridgeUiSurfaceSnapshots(nextSnapshots);
      }, 180);
    },
    [bridgeUiSurfacePersistenceTimeoutRef, saveBridgeUiSurfaceSnapshots],
  );

  return {
    scheduleRunWatchdogExpiry,
    bumpRunWatchdog,
    clearRunWatchdog,
    readThreadContextUsage,
    saveChatModelPreferences,
    saveChatPlanSnapshots,
    saveBridgeUiSurfaceSnapshots,
    scheduleBridgeUiSurfaceSnapshotsPersist,
  };
}

export type MainScreenThreadSnapshotStoreResult = ReturnType<
  typeof useMainScreenThreadSnapshotStore
>;
