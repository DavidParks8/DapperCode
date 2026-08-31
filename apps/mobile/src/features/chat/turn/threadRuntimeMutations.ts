import { pendingPlanImplementationPromptsAtom } from '../state/composer';
import { threadRuntimeSnapshotsAtom } from '../state/runtime';
import { liveAssistantByThreadAtom } from '../state/turn';
import { agentRootThreadIdAtom, relatedAgentThreadsAtom } from '../../workspace/state/workspace';
import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type {
  BridgeThreadSchedulesState,
  BridgeUiSurface,
  BridgeThreadQueueState,
} from '@bridge/types/types';
import {
  type ActivePlanState,
  type SessionTokenTotals,
  type ThreadContextUsage,
  mergeThreadContextUsage,
  upsertBridgeUiSurfaceList,
  removeBridgeUiSurfaceFromList,
} from '../helpers/helpers';
import type {
  MainScreenRuntimeWatchdogSyncContext,
  MainScreenRuntimeWatchdogSyncResult,
} from './runtimeWatchdogSync';

export type MainScreenThreadRuntimeMutationsContext = MainScreenRuntimeWatchdogSyncContext &
  MainScreenRuntimeWatchdogSyncResult;

export const DELETED_THREAD_TOMBSTONE_LIMIT = 2_048;

export function rememberDeletedThreadId(tombstones: Set<string>, threadId: string): void {
  tombstones.delete(threadId);
  tombstones.add(threadId);
  while (tombstones.size > DELETED_THREAD_TOMBSTONE_LIMIT) {
    const oldest = tombstones.values().next().value;
    if (!oldest) {
      return;
    }
    tombstones.delete(oldest);
  }
}

export function useMainScreenThreadRuntimeMutations(
  context: MainScreenThreadRuntimeMutationsContext,
) {
  const {
    bumpAgentRuntimeRevision,
    autoEnabledPlanTurnIdByThreadRef,
    bridgeUiSurfaceSnapshotsRef,
    chatPlanSnapshotsRef,
    deletedThreadIdsRef,
    dismissedPlanImplementationTurnIdByThreadRef,
    liveReasoningBuffersRef,
    liveReasoningMessageIdsRef,
    parentChatCacheRef,
    pendingOptimisticQueuedMessagesRef,
    pendingOptimisticUserMessagesRef,
    planItemTurnIdByThreadRef,
    planPanelLastTurnByThreadRef,
    rememberBridgeUiSurfaceSnapshots,
    rememberChatPlanSnapshot,
    store,
    threadReasoningBuffersRef,
    threadRuntimeSnapshotsRef,
    upsertThreadRuntimeSnapshot,
  } = context;
  const setPendingPlanImplementationPrompts = useSetAtom(pendingPlanImplementationPromptsAtom);

  const cacheThreadBridgeUiSurface = useCallback(
    (threadId: string, surface: BridgeUiSurface) => {
      upsertThreadRuntimeSnapshot(threadId, (previous) => ({
        bridgeUiSurfaces: upsertBridgeUiSurfaceList(previous.bridgeUiSurfaces ?? [], surface),
      }));
      rememberBridgeUiSurfaceSnapshots(threadId, (previous) =>
        upsertBridgeUiSurfaceList(previous, surface),
      );
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot],
  );

  const removeThreadBridgeUiSurface = useCallback(
    (surfaceId: string, threadId?: string | null) => {
      if (threadId) {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          bridgeUiSurfaces: removeBridgeUiSurfaceFromList(
            previous.bridgeUiSurfaces ?? [],
            surfaceId,
          ),
        }));
        rememberBridgeUiSurfaceSnapshots(threadId, (previous) =>
          removeBridgeUiSurfaceFromList(previous, surfaceId),
        );
      } else {
        for (const [snapshotThreadId, snapshot] of Object.entries(
          threadRuntimeSnapshotsRef.current,
        )) {
          if (!snapshot.bridgeUiSurfaces?.some((surface) => surface.id === surfaceId)) {
            continue;
          }
          upsertThreadRuntimeSnapshot(snapshotThreadId, (previous) => ({
            bridgeUiSurfaces: removeBridgeUiSurfaceFromList(
              previous.bridgeUiSurfaces ?? [],
              surfaceId,
            ),
          }));
          rememberBridgeUiSurfaceSnapshots(snapshotThreadId, (previous) =>
            removeBridgeUiSurfaceFromList(previous, surfaceId),
          );
        }
      }
      bumpAgentRuntimeRevision();
    },
    [
      bumpAgentRuntimeRevision,
      rememberBridgeUiSurfaceSnapshots,
      threadRuntimeSnapshotsRef,
      upsertThreadRuntimeSnapshot,
    ],
  );

  const replaceThreadBridgeUiSurfaces = useCallback(
    (threadId: string, surfaces: BridgeUiSurface[]) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        bridgeUiSurfaces: surfaces,
      }));
      rememberBridgeUiSurfaceSnapshots(threadId, () => surfaces);
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadQueueState = useCallback(
    (threadId: string, queueState: BridgeThreadQueueState | null) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        queuedMessages: queueState ? [...queueState.pendingSteers, ...queueState.items] : [],
        pendingSteerMessageIds: queueState?.pendingSteers.map((item) => item.id) ?? [],
        editingQueuedMessageId: queueState?.editingItemId ?? null,
        waitingForToolCalls: queueState?.waitingForToolCalls ?? false,
        steeringInFlight: queueState?.steeringInFlight ?? false,
        queuedMessageError: queueState?.lastError ?? null,
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadSchedulesState = useCallback(
    (threadId: string, schedulesState: BridgeThreadSchedulesState | null) => {
      if (deletedThreadIdsRef.current.has(threadId)) {
        return;
      }
      upsertThreadRuntimeSnapshot(threadId, () => ({
        scheduledPrompts: schedulesState?.schedules ?? [],
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, deletedThreadIdsRef, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadTurnState = useCallback(
    (
      threadId: string,
      options: {
        activeTurnId?: string | null;
        runWatchdogUntil?: number;
      },
    ) => {
      upsertThreadRuntimeSnapshot(threadId, () => options);
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadContextUsage = useCallback(
    (threadId: string, contextUsage: ThreadContextUsage | null) => {
      if (!contextUsage) {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          contextUsage: null,
        }));
        return;
      }

      const previousContextUsage =
        threadRuntimeSnapshotsRef.current[threadId]?.contextUsage ?? null;
      const mergedContextUsage = mergeThreadContextUsage(previousContextUsage, contextUsage);

      upsertThreadRuntimeSnapshot(threadId, (previous) => {
        return {
          contextUsage: mergeThreadContextUsage(previous.contextUsage ?? null, mergedContextUsage),
        };
      });
    },
    [threadRuntimeSnapshotsRef, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadSessionTokenTotals = useCallback(
    (threadId: string, tokenTotals: SessionTokenTotals | null) => {
      if (!tokenTotals) {
        return;
      }

      upsertThreadRuntimeSnapshot(threadId, () => ({ tokenTotals }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot],
  );

  const cacheThreadPlan = useCallback(
    (
      threadId: string,
      nextPlan:
        ActivePlanState | null | ((previous: ActivePlanState | null) => ActivePlanState | null),
    ) => {
      upsertThreadRuntimeSnapshot(threadId, (previous) => ({
        plan: typeof nextPlan === 'function' ? nextPlan(previous.plan ?? null) : nextPlan,
      }));
      rememberChatPlanSnapshot(threadId, threadRuntimeSnapshotsRef.current[threadId]?.plan ?? null);
    },
    [rememberChatPlanSnapshot, threadRuntimeSnapshotsRef, upsertThreadRuntimeSnapshot],
  );

  const clearPendingPlanImplementationPrompt = useCallback(
    (threadId: string) => {
      if (!threadId) {
        return;
      }

      setPendingPlanImplementationPrompts((prev) => {
        if (!(threadId in prev)) {
          return prev;
        }

        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    },
    [setPendingPlanImplementationPrompts],
  );

  const forgetThreadRuntimeState = useCallback(
    (threadId: string) => {
      store.set(threadRuntimeSnapshotsAtom, (current) => {
        if (!(threadId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      store.set(liveAssistantByThreadAtom, (current) => {
        if (!(threadId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      store.set(relatedAgentThreadsAtom, (current) =>
        current.filter((thread) => thread.id !== threadId),
      );
      if (store.get(agentRootThreadIdAtom) === threadId) {
        store.set(agentRootThreadIdAtom, null);
      }
      rememberDeletedThreadId(deletedThreadIdsRef.current, threadId);
      for (const state of [
        autoEnabledPlanTurnIdByThreadRef.current,
        bridgeUiSurfaceSnapshotsRef.current,
        chatPlanSnapshotsRef.current,
        dismissedPlanImplementationTurnIdByThreadRef.current,
        liveReasoningBuffersRef.current,
        liveReasoningMessageIdsRef.current,
        parentChatCacheRef.current,
        pendingOptimisticQueuedMessagesRef.current,
        pendingOptimisticUserMessagesRef.current,
        planItemTurnIdByThreadRef.current,
        planPanelLastTurnByThreadRef.current,
        threadReasoningBuffersRef.current,
      ]) {
        delete state[threadId];
      }
      clearPendingPlanImplementationPrompt(threadId);
      bumpAgentRuntimeRevision();
    },
    [
      autoEnabledPlanTurnIdByThreadRef,
      bridgeUiSurfaceSnapshotsRef,
      bumpAgentRuntimeRevision,
      chatPlanSnapshotsRef,
      clearPendingPlanImplementationPrompt,
      deletedThreadIdsRef,
      dismissedPlanImplementationTurnIdByThreadRef,
      liveReasoningBuffersRef,
      liveReasoningMessageIdsRef,
      parentChatCacheRef,
      pendingOptimisticQueuedMessagesRef,
      pendingOptimisticUserMessagesRef,
      planItemTurnIdByThreadRef,
      planPanelLastTurnByThreadRef,
      store,
      threadReasoningBuffersRef,
    ],
  );

  return {
    cacheThreadBridgeUiSurface,
    removeThreadBridgeUiSurface,
    replaceThreadBridgeUiSurfaces,
    cacheThreadQueueState,
    cacheThreadSchedulesState,
    cacheThreadTurnState,
    cacheThreadContextUsage,
    cacheThreadSessionTokenTotals,
    cacheThreadPlan,
    clearPendingPlanImplementationPrompt,
    forgetThreadRuntimeState,
  };
}

export type MainScreenThreadRuntimeMutationsResult = ReturnType<
  typeof useMainScreenThreadRuntimeMutations
>;
