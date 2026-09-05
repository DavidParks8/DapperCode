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
import { startNewChatAtom } from '@shell/navigation/actions';
import type {
  MainScreenComposerSubmitActionsContext,
  MainScreenComposerSubmitActionsResult,
} from '../composer/submitActions';

export type MainScreenReplayRecoveryEngineContext = MainScreenComposerSubmitActionsContext &
  MainScreenComposerSubmitActionsResult;

interface ReplayRecoveryInstallGuard {
  liveAssistantByThread: AgUiLiveAssistantMessages;
  runtimeSnapshotsByThread: Record<string, ThreadRuntimeSnapshot>;
  scheduledPromptsByThread: Record<string, ThreadRuntimeSnapshot['scheduledPrompts']>;
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
    deletedThreadIdsRef,
    forgetThreadRuntimeState,
    mergeChatWithPendingOptimisticMessages,
    pendingOptimisticQueuedMessagesRef,
    pendingOptimisticUserMessagesRef,
    readThreadContextUsage,
    readThreadSessionTokenTotals,
    replayRecoveryAbortControllerRef,
    replayRecoveryEpochResetPendingRef,
    replayRecoveryGenerationRef,
    replayRecoveryRetryTimerRef,
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
      for (const threadId of snapshot.missingThreadIds) {
        api.forgetChat(threadId);
        forgetThreadRuntimeState(threadId);
      }
      if (snapshot.missingThreadIds.some((threadId) => threadId === chatIdRef.current)) {
        store.set(startNewChatAtom, { keepDrawerOpen: true });
      }
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

      for (const { chat, queue, schedules } of snapshot.threads) {
        if (deletedThreadIdsRef.current.has(chat.id)) {
          continue;
        }
        api.rememberChat(chat);
        const pendingThreadApproval = approvalsByThread.get(chat.id) ?? null;
        const pendingThreadUserInput = userInputsByThread.get(chat.id) ?? null;
        const running = isChatLikelyRunning(chat);
        const plan = chat.latestPlan
          ? toPersistedActivePlanState(chat.latestPlan, chat.updatedAt)
          : null;
        const runtimeAdvanced =
          threadRuntimeSnapshotsRef.current[chat.id] !== guard.runtimeSnapshotsByThread[chat.id];
        if (runtimeAdvanced) {
          runtimeAdvancedThreadIds.add(chat.id);
          store.set(threadRuntimeSnapshotsAtom, (current) => {
            const currentThread = current[chat.id];
            if (currentThread?.scheduledPrompts !== guard.scheduledPromptsByThread[chat.id]) {
              return current;
            }
            return {
              ...current,
              [chat.id]: {
                ...(currentThread ?? { updatedAtMs: Date.now() }),
                scheduledPrompts: schedules.schedules,
                updatedAtMs: Date.now(),
              },
            };
          });
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
            editingQueuedMessageId: queue.editingItemId ?? null,
            waitingForToolCalls: queue.waitingForToolCalls,
            steeringInFlight: queue.steeringInFlight,
            queuedMessageError: queue.lastError,
            scheduledPrompts: schedules.schedules,
            contextUsage: readThreadContextUsage(chat.acpUsage),
            tokenTotals: readThreadSessionTokenTotals(chat.tokenTotals),
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
      deletedThreadIdsRef,
      forgetThreadRuntimeState,
      mergeChatWithPendingOptimisticMessages,
      readThreadContextUsage,
      readThreadSessionTokenTotals,
      setActiveBridgeUiSurfaces,
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
        scheduledPromptsByThread: Object.fromEntries(
          Object.entries(threadRuntimeSnapshotsRef.current).map(([threadId, runtime]) => [
            threadId,
            runtime.scheduledPrompts,
          ]),
        ),
        selectedThreadId: chatIdRef.current,
      };
      replayRecoveryAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      replayRecoveryAbortControllerRef.current = abortController;
      if (replayRecoveryRetryTimerRef.current) {
        clearTimeout(replayRecoveryRetryTimerRef.current);
        replayRecoveryRetryTimerRef.current = null;
      }

      const trackedThreadIds = () =>
        [
          chatIdRef.current,
          agentDetailThreadId,
          agentRootThreadIdRef.current,
          ...relatedAgentThreads.map((thread) => thread.id),
          ...(api.peekChats()?.map((thread) => thread.id) ?? []),
          ...(api.peekAllChats()?.map((thread) => thread.id) ?? []),
          ...Object.keys(threadRuntimeSnapshotsRef.current),
          ...Object.keys(pendingOptimisticUserMessagesRef.current),
          ...Object.keys(pendingOptimisticQueuedMessagesRef.current),
        ].filter((threadId) => !threadId || !deletedThreadIdsRef.current.has(threadId));

      const attempt = async () => {
        try {
          const snapshot = await fetchReplayRecoverySnapshot(
            api,
            trackedThreadIds(),
            abortController.signal,
            deletedThreadIdsRef.current,
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
      deletedThreadIdsRef,
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
