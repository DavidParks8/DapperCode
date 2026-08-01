import {
  activeBridgeUiSurfacesAtom,
  activePlanAtom,
  activeTurnIdAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import { selectedCollaborationModeAtom } from '../../state/mainScreen/models';
import { useBridgeCapabilitiesResource } from '../../state/bridge/capabilities';
import { activityAtom } from '../../state/mainScreen/composer';
import { useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import {
  buildUserInputDrafts,
  resolveSnapshotCollaborationMode,
  appendRunEventHistory,
  upsertBridgeUiSurfaceList,
  mergePersistedPlanSnapshots,
} from './mainScreenHelpers';
import type {
  MainScreenThreadRuntimeMutationsContext,
  MainScreenThreadRuntimeMutationsResult,
} from './mainScreenThreadRuntimeMutations';

export type MainScreenSelectedRuntimeSelectorsContext = MainScreenThreadRuntimeMutationsContext &
  MainScreenThreadRuntimeMutationsResult;

export function useMainScreenSelectedRuntimeSelectors(
  context: MainScreenSelectedRuntimeSelectorsContext,
) {
  const {
    api,
    approvalController,
    bridgeUiSurfaceSnapshotsRef,
    cacheThreadPendingApproval,
    chatIdRef,
    chatPlanSnapshotsRef,
    onChatContextChange,
    onChatOpeningStateChange,
    openingChatId,
    persistenceController,
    runWatchdogUntilRef,
    scheduleRunWatchdogExpiry,
    selectedChat,
    setActiveCommands,
    setChatPlanSnapshotsLoaded,
    setRunWatchdogNow,
    setStreamingText,
    threadRuntimeSnapshotsRef,
    upsertThreadRuntimeSnapshot,
  } = context;
  const setPendingApproval = useSetAtom(pendingApprovalAtom);
  const setPendingUserInputRequest = useSetAtom(pendingUserInputRequestAtom);
  const setUserInputDrafts = useSetAtom(userInputDraftsAtom);
  const setUserInputError = useSetAtom(userInputErrorAtom);
  const setResolvingUserInput = useSetAtom(resolvingUserInputAtom);
  const setActivePlan = useSetAtom(activePlanAtom);
  const setActiveBridgeUiSurfaces = useSetAtom(activeBridgeUiSurfacesAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const { value: bridgeCapabilities } = useBridgeCapabilitiesResource();
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const setActivity = useSetAtom(activityAtom);

  // Held in a ref so the snapshot applier keeps a stable identity. The capability
  // is resolved for the thread being applied rather than the last rendered chat,
  // because callers apply a snapshot in the same tick they select the chat.
  const bridgeCapabilitiesRef = useRef(bridgeCapabilities);
  bridgeCapabilitiesRef.current = bridgeCapabilities;
  const supportsPlanModeForThread = useCallback(
    (threadId: string) => {
      // `peekChatSummary` also resolves threads the drawer has listed but the
      // user has never opened, and avoids cloning a whole transcript to read one
      // field.
      const agentId = api.peekChatSummary(threadId)?.agentId;
      return agentId
        ? bridgeCapabilitiesRef.current?.supportsByAgent[agentId]?.planMode === true
        : false;
    },
    [api],
  );

  const applyThreadRuntimeSnapshot = useCallback(
    (threadId: string) => {
      if (!threadId) {
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        setSelectedCollaborationMode('default');
        return;
      }

      const snapshot = threadRuntimeSnapshotsRef.current[threadId];
      if (!snapshot) {
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        setSelectedCollaborationMode('default');
        return;
      }

      setSelectedCollaborationMode(
        resolveSnapshotCollaborationMode(snapshot, supportsPlanModeForThread(threadId)),
      );
      if (snapshot.activeCommands !== undefined) {
        setActiveCommands(snapshot.activeCommands);
      }
      if (snapshot.streamingText !== undefined) {
        setStreamingText(snapshot.streamingText);
      }
      if (snapshot.pendingApproval !== undefined) {
        setPendingApproval(snapshot.pendingApproval);
      }
      if (snapshot.pendingUserInputRequest !== undefined) {
        setPendingUserInputRequest(snapshot.pendingUserInputRequest);
        setUserInputDrafts(
          snapshot.pendingUserInputRequest
            ? buildUserInputDrafts(snapshot.pendingUserInputRequest)
            : {},
        );
        setUserInputError(null);
        setResolvingUserInput(false);
      }
      setActivePlan(snapshot.plan ?? null);
      setActiveBridgeUiSurfaces(snapshot.bridgeUiSurfaces ?? []);
      if (snapshot.activeTurnId !== undefined) {
        setActiveTurnId(snapshot.activeTurnId);
      }
      if (snapshot.activity) {
        setActivity(snapshot.activity);
      }
      if (
        typeof snapshot.runWatchdogUntil === 'number' &&
        snapshot.runWatchdogUntil > runWatchdogUntilRef.current
      ) {
        runWatchdogUntilRef.current = snapshot.runWatchdogUntil;
        setRunWatchdogNow(Date.now());
        scheduleRunWatchdogExpiry(snapshot.runWatchdogUntil);
      }
    },
    [scheduleRunWatchdogExpiry, supportsPlanModeForThread],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const snapshots = await persistenceController.loadPlanSnapshots();
      if (cancelled) return;
      // A live plan event (including an explicit clear when a turn settles or
      // starts anew) may already have reached a thread's runtime snapshot
      // while this persisted load was in flight; that live state is newer and
      // must win rather than being replaced wholesale by a stale disk
      // snapshot, mirroring how the bridge UI surface hydration below folds
      // live entries over what was persisted.
      const mergedSnapshots = mergePersistedPlanSnapshots(
        snapshots,
        threadRuntimeSnapshotsRef.current,
      );
      chatPlanSnapshotsRef.current = mergedSnapshots;
      for (const [threadId, plan] of Object.entries(mergedSnapshots)) {
        upsertThreadRuntimeSnapshot(threadId, () => ({ plan }));
      }
      if (chatIdRef.current) applyThreadRuntimeSnapshot(chatIdRef.current);
      setChatPlanSnapshotsLoaded(true);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyThreadRuntimeSnapshot, persistenceController, upsertThreadRuntimeSnapshot]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const persisted = await persistenceController.loadBridgeUiSurfaces();
      if (cancelled) return;
      const nextSnapshots = { ...persisted };
      for (const [threadId, surfaces] of Object.entries(bridgeUiSurfaceSnapshotsRef.current)) {
        nextSnapshots[threadId] = surfaces.reduce(
          (merged, surface) => upsertBridgeUiSurfaceList(merged, surface),
          nextSnapshots[threadId] ?? [],
        );
      }

      bridgeUiSurfaceSnapshotsRef.current = nextSnapshots;
      for (const [threadId, surfaces] of Object.entries(nextSnapshots)) {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          bridgeUiSurfaces: (previous.bridgeUiSurfaces ?? []).reduce(
            (merged, surface) => upsertBridgeUiSurfaceList(merged, surface),
            surfaces,
          ),
        }));
      }
      if (chatIdRef.current) {
        applyThreadRuntimeSnapshot(chatIdRef.current);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyThreadRuntimeSnapshot, persistenceController, upsertThreadRuntimeSnapshot]);

  const refreshPendingApprovalsForThread = useCallback(
    async (threadId: string) => {
      try {
        const match = await approvalController.findForThread(threadId);
        cacheThreadPendingApproval(threadId, match);
        if (chatIdRef.current === threadId) {
          setPendingApproval(match);
          if (match) {
            setActivity({
              tone: 'idle',
              title: 'Waiting for approval',
              detail: match.command ?? match.kind,
            });
          }
        }
      } catch {
        // Best effort hydration for externally-started turns.
      }
    },
    [approvalController, cacheThreadPendingApproval],
  );

  const pushActiveCommand = useCallback((threadId: string, eventType: string, detail: string) => {
    setActiveCommands((prev) => appendRunEventHistory(prev, threadId, eventType, detail));
  }, []);

  useEffect(() => {
    onChatContextChange?.(selectedChat);
  }, [onChatContextChange, selectedChat]);

  useEffect(() => {
    onChatOpeningStateChange?.(openingChatId);
  }, [onChatOpeningStateChange, openingChatId]);

  return {
    applyThreadRuntimeSnapshot,
    refreshPendingApprovalsForThread,
    pushActiveCommand,
  };
}

export type MainScreenSelectedRuntimeSelectorsResult = ReturnType<
  typeof useMainScreenSelectedRuntimeSelectors
>;
