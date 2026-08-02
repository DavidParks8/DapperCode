import {
  activeBridgeUiSurfacesAtom,
  activePlanAtom,
  activeTurnIdAtom,
  errorAtom,
  liveAssistantByThreadAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  stoppingTurnAtom,
  userInputDraftsAtom,
} from '../state/turn';
import { activityAtom } from '../state/composer';
import { bridgeCapabilitiesAtom } from '../state/models';
import { relatedAgentThreadsAtom } from '../../workspace/state/workspace';
import { threadRuntimeSnapshotsAtom } from '../state/runtime';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type { AgUiLiveAssistantMessages } from '@bridge/agui/agUi';
import {
  RUN_WATCHDOG_MS,
  type ThreadRuntimeSnapshot,
  toPersistedActivePlanState,
  isChatLikelyRunning,
} from '../helpers/helpers';
import {
  fetchReplayRecoverySnapshot,
  ReplayRecoveryProtocolError,
  type ReplayRecoverySnapshot,
} from './controllers/replayRecoveryController';
import { getTranscriptContinuationState } from '../transcript/controllers/continuationController';
import { resolveEquivalentChat } from '../state/chatState';
import type {
  MainScreenComposerSubmitActionsContext,
  MainScreenComposerSubmitActionsResult,
} from '../composer/submitActions';

export type MainScreenReplayRecoveryEngineContext = MainScreenComposerSubmitActionsContext &
  MainScreenComposerSubmitActionsResult;

interface ReplayRecoveryInstallGuard {
  liveAssistantByThread: AgUiLiveAssistantMessages;
  runtimeSnapshotsByThread: Record<string, ThreadRuntimeSnapshot>;
  selectedThreadId: string | null;
}

export function useMainScreenReplayRecoveryEngine(context: MainScreenReplayRecoveryEngineContext) {
  const {
    agentRootThreadIdRef,
    agentDetailThreadId,
    api,
    applyThreadRuntimeSnapshot,
    bridgeUiSurfaceSnapshotsRef,
    bumpAgentRuntimeRevision,
    chatIdRef,
    chatPlanSnapshotsRef,
    mergeChatWithPendingOptimisticMessages,
    pendingOptimisticQueuedMessagesRef,
    pendingOptimisticUserMessagesRef,
    readThreadContextUsage,
    replayRecoveryAbortControllerRef,
    replayRecoveryEpochResetPendingRef,
    replayRecoveryGenerationRef,
    replayRecoveryRetryTimerRef,
    setActiveCommands,
    setSelectedChat,
    setStreamingText,
    setTranscriptContinuationState,
    store,
    threadRuntimeSnapshotsRef,
    ws,
  } = context;
  const setError = useSetAtom(errorAtom);
  const setPendingApproval = useSetAtom(pendingApprovalAtom);
  const setPendingUserInputRequest = useSetAtom(pendingUserInputRequestAtom);
  const setUserInputDrafts = useSetAtom(userInputDraftsAtom);
  const setActivePlan = useSetAtom(activePlanAtom);
  const setActiveBridgeUiSurfaces = useSetAtom(activeBridgeUiSurfacesAtom);
  const setLiveAssistantByThread = useSetAtom(liveAssistantByThreadAtom);
  const setActiveTurnId = useSetAtom(activeTurnIdAtom);
  const setStoppingTurn = useSetAtom(stoppingTurnAtom);
  const setBridgeCapabilities = useSetAtom(bridgeCapabilitiesAtom);
  const setActivity = useSetAtom(activityAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const installReplayRecoverySnapshot = useCallback(
    (snapshot: ReplayRecoverySnapshot, guard: ReplayRecoveryInstallGuard) => {
      const approvalsByThread = new Map(
        snapshot.approvals.map((approval) => [approval.threadId, approval] as const),
      );
      const userInputsByThread = new Map(
        snapshot.userInputs.map((request) => [request.threadId, request] as const),
      );
      const recoveredThreadIds = new Set(snapshot.threads.map(({ chat }) => chat.id));
      const runtimeAdvancedThreadIds = new Set<string>();
      setBridgeCapabilities(snapshot.capabilities);
      // A recovery read is asynchronous. Only retire live state that is still the exact state
      // captured when the read began; newer events belong to the post-recovery timeline.
      setLiveAssistantByThread((current) => {
        let next = current;
        for (const threadId of recoveredThreadIds) {
          if (
            current[threadId] === undefined ||
            current[threadId] !== guard.liveAssistantByThread[threadId]
          ) {
            continue;
          }
          if (next === current) {
            next = { ...current };
          }
          delete next[threadId];
        }
        return next;
      });

      for (const { chat, queue } of snapshot.threads) {
        api.rememberChat(chat);
        const pendingThreadApproval = approvalsByThread.get(chat.id) ?? null;
        const pendingThreadUserInput = userInputsByThread.get(chat.id) ?? null;
        const running = isChatLikelyRunning(chat);
        const plan = chat.latestPlan
          ? toPersistedActivePlanState(chat.latestPlan, chat.updatedAt)
          : null;
        if (
          threadRuntimeSnapshotsRef.current[chat.id] !== guard.runtimeSnapshotsByThread[chat.id]
        ) {
          runtimeAdvancedThreadIds.add(chat.id);
          continue;
        }
        store.set(threadRuntimeSnapshotsAtom, (current) => ({
          ...current,
          [chat.id]: {
            activity: pendingThreadApproval
              ? { tone: 'idle', title: 'Waiting for approval' }
              : pendingThreadUserInput
                ? { tone: 'idle', title: 'Waiting for input' }
                : running
                  ? { tone: 'running', title: 'Working' }
                  : chat.status === 'error'
                    ? { tone: 'error', title: 'Turn failed', detail: chat.lastError }
                    : chat.status === 'complete'
                      ? { tone: 'complete', title: 'Turn completed' }
                      : { tone: 'idle', title: 'Ready' },
            activeCommands: [],
            latestCommand: null,
            streamingText: null,
            pendingApproval: pendingThreadApproval,
            pendingUserInputRequest: pendingThreadUserInput,
            bridgeUiSurfaces: [],
            queuedMessages: [...queue.pendingSteers, ...queue.items],
            pendingSteerMessageIds: queue.pendingSteers.map((item) => item.id),
            waitingForToolCalls: queue.waitingForToolCalls,
            steeringInFlight: queue.steeringInFlight,
            queuedMessageError: queue.lastError,
            contextUsage: readThreadContextUsage(chat.acpUsage),
            plan,
            activeTurnId: chat.activeTurnId ?? chat.acpActive?.sourceTurnId ?? null,
            runWatchdogUntil: running ? Date.now() + RUN_WATCHDOG_MS : 0,
            updatedAtMs: Date.now(),
          },
        }));
        if (plan) {
          chatPlanSnapshotsRef.current[chat.id] = plan;
        } else {
          delete chatPlanSnapshotsRef.current[chat.id];
        }
        bridgeUiSurfaceSnapshotsRef.current[chat.id] = [];
      }

      const selectedId = chatIdRef.current;
      const selectedSnapshot = snapshot.threads.find(({ chat }) => chat.id === selectedId);
      const selectionChanged = selectedId !== guard.selectedThreadId;
      if (selectedSnapshot && !selectionChanged) {
        const selected = mergeChatWithPendingOptimisticMessages(selectedSnapshot.chat);
        setSelectedChat((previous) =>
          previous?.id === selected.id ? resolveEquivalentChat(previous, selected) : selected,
        );
        setTranscriptContinuationState(getTranscriptContinuationState(selected));
        setStoppingTurn(false);
        setError(null);
        if (!runtimeAdvancedThreadIds.has(selected.id)) {
          applyThreadRuntimeSnapshot(selected.id);
        }
      } else if (!selectedId && !selectionChanged) {
        setActiveCommands([]);
        setStreamingText(null);
        setPendingApproval(null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        setActiveTurnId(null);
        setActivity({ tone: 'idle', title: 'Ready' });
      }
      bumpAgentRuntimeRevision();
    },
    [
      api,
      applyThreadRuntimeSnapshot,
      bridgeUiSurfaceSnapshotsRef,
      bumpAgentRuntimeRevision,
      chatIdRef,
      chatPlanSnapshotsRef,
      mergeChatWithPendingOptimisticMessages,
      readThreadContextUsage,
      setActiveBridgeUiSurfaces,
      setActiveCommands,
      setActivePlan,
      setActiveTurnId,
      setActivity,
      setBridgeCapabilities,
      setError,
      setLiveAssistantByThread,
      setPendingApproval,
      setPendingUserInputRequest,
      setSelectedChat,
      setStoppingTurn,
      setStreamingText,
      setTranscriptContinuationState,
      setUserInputDrafts,
      store,
      threadRuntimeSnapshotsRef,
    ],
  );

  const recoverReplayGap = useCallback(
    (resumeAfterEventId: number | null, acknowledge: boolean) => {
      const generation = replayRecoveryGenerationRef.current + 1;
      replayRecoveryGenerationRef.current = generation;
      const installGuard: ReplayRecoveryInstallGuard = {
        liveAssistantByThread: store.get(liveAssistantByThreadAtom),
        runtimeSnapshotsByThread: { ...threadRuntimeSnapshotsRef.current },
        selectedThreadId: chatIdRef.current,
      };
      replayRecoveryAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      replayRecoveryAbortControllerRef.current = abortController;
      if (replayRecoveryRetryTimerRef.current) {
        clearTimeout(replayRecoveryRetryTimerRef.current);
        replayRecoveryRetryTimerRef.current = null;
      }

      const trackedThreadIds = () => [
        chatIdRef.current,
        agentDetailThreadId,
        agentRootThreadIdRef.current,
        ...relatedAgentThreads.map((thread) => thread.id),
        ...(api.peekChats()?.map((thread) => thread.id) ?? []),
        ...(api.peekAllChats()?.map((thread) => thread.id) ?? []),
        ...Object.keys(threadRuntimeSnapshotsRef.current),
        ...Object.keys(pendingOptimisticUserMessagesRef.current),
        ...Object.keys(pendingOptimisticQueuedMessagesRef.current),
      ];

      const attempt = async () => {
        try {
          const snapshot = await fetchReplayRecoverySnapshot(
            api,
            trackedThreadIds(),
            abortController.signal,
          );
          if (generation !== replayRecoveryGenerationRef.current) {
            return;
          }
          installReplayRecoverySnapshot(snapshot, installGuard);
          replayRecoveryEpochResetPendingRef.current = false;
          if (acknowledge && resumeAfterEventId !== null) {
            ws.acknowledgeSnapshotRecovery(resumeAfterEventId);
          }
        } catch (recoveryError) {
          if (generation !== replayRecoveryGenerationRef.current) {
            return;
          }
          if (recoveryError instanceof ReplayRecoveryProtocolError) {
            replayRecoveryGenerationRef.current += 1;
            replayRecoveryAbortControllerRef.current = null;
            if (replayRecoveryEpochResetPendingRef.current) {
              setError(
                'Replay recovery exceeded the bridge protocol limit after reconnect. Reopen the connection after reducing loaded thread history.',
              );
              return;
            }
            replayRecoveryEpochResetPendingRef.current = true;
            ws.resetRecoveryEpoch();
            return;
          }
          replayRecoveryRetryTimerRef.current = setTimeout(() => {
            replayRecoveryRetryTimerRef.current = null;
            void attempt();
          }, 1_000);
        }
      };
      void attempt();
    },
    [
      agentDetailThreadId,
      agentRootThreadIdRef,
      api,
      chatIdRef,
      installReplayRecoverySnapshot,
      pendingOptimisticQueuedMessagesRef,
      pendingOptimisticUserMessagesRef,
      relatedAgentThreads,
      replayRecoveryAbortControllerRef,
      replayRecoveryEpochResetPendingRef,
      replayRecoveryGenerationRef,
      replayRecoveryRetryTimerRef,
      setError,
      store,
      threadRuntimeSnapshotsRef,
      ws,
    ],
  );

  return {
    installReplayRecoverySnapshot,
    recoverReplayGap,
  };
}

export type MainScreenReplayRecoveryEngineResult = ReturnType<
  typeof useMainScreenReplayRecoveryEngine
>;
