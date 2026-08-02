import { errorAtom } from '../state/turn';
import {
  agentRootThreadIdAtom,
  loadingAgentThreadsAtom,
  relatedAgentThreadsAtom,
} from '../../workspace/state/workspace';
import { agentThreadMenuVisibleAtom } from '../state/modals';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import {
  AGENT_THREADS_SYNC_INTERVAL_MS,
  AGENT_THREADS_IDLE_SYNC_INTERVAL_MS,
  AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS,
} from '../helpers/helpers';
import { areChatSummaryListsEquivalent } from '../state/chatState';
import type {
  MainScreenWorkspaceBrowserStateContext,
  MainScreenWorkspaceBrowserStateResult,
} from '../session/workspaceBrowserState';

export type MainScreenAgentThreadsRefreshContext = MainScreenWorkspaceBrowserStateContext &
  MainScreenWorkspaceBrowserStateResult;

export function useMainScreenAgentThreadsRefresh(context: MainScreenAgentThreadsRefreshContext) {
  const {
    activeTurnIdRef,
    agentThreadsController,
    agentThreadsRefreshTimerRef,
    agentThreadsRequestRef,
    appStateRef,
    chatIdRef,
    clearDeferredDisconnectActivity,
    clearForegroundAgentRefresh,
    runWatchdogUntilRef,
    selectedChatId,
    selectedChatRef,
  } = context;
  const setError = useSetAtom(errorAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const agentRootThreadId = useAtomValue(agentRootThreadIdAtom);
  const setRelatedAgentThreads = useSetAtom(relatedAgentThreadsAtom);
  const setAgentRootThreadId = useSetAtom(agentRootThreadIdAtom);
  const setLoadingAgentThreads = useSetAtom(loadingAgentThreadsAtom);
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);

  const refreshAgentThreads = useCallback(
    async (focusChatId?: string | null, options?: { showLoading?: boolean }) => {
      const activeChatId = focusChatId ?? chatIdRef.current;
      if (!activeChatId) {
        setRelatedAgentThreads([]);
        setAgentRootThreadId(null);
        return {
          rootThreadId: null,
          threads: [],
        };
      }

      const requestId = agentThreadsRequestRef.current + 1;
      agentThreadsRequestRef.current = requestId;
      if (options?.showLoading) {
        setLoadingAgentThreads(true);
      }

      try {
        const related = await agentThreadsController.loadRelated(
          activeChatId,
          selectedChatRef.current?.id === activeChatId ? selectedChatRef.current : null,
        );

        if (agentThreadsRequestRef.current !== requestId) {
          return related;
        }

        setRelatedAgentThreads((prev) =>
          areChatSummaryListsEquivalent(prev, related.threads) ? prev : related.threads,
        );
        setAgentRootThreadId((prev) =>
          prev === related.rootThreadId ? prev : related.rootThreadId,
        );
        return related;
      } catch (err) {
        if (agentThreadsRequestRef.current === requestId && options?.showLoading) {
          setError((err as Error).message);
        }
        return {
          rootThreadId: null,
          threads: [],
        };
      } finally {
        if (agentThreadsRequestRef.current === requestId && options?.showLoading) {
          setLoadingAgentThreads(false);
        }
      }
    },
    [
      agentThreadsController,
      agentThreadsRequestRef,
      chatIdRef,
      selectedChatRef,
      setAgentRootThreadId,
      setError,
      setLoadingAgentThreads,
      setRelatedAgentThreads,
    ],
  );

  const scheduleAgentThreadsRefresh = useCallback(
    (focusChatId?: string | null) => {
      const activeChatId = focusChatId ?? chatIdRef.current;
      if (!activeChatId) {
        return;
      }

      const existingTimer = agentThreadsRefreshTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      agentThreadsRefreshTimerRef.current = setTimeout(() => {
        agentThreadsRefreshTimerRef.current = null;
        void refreshAgentThreads(activeChatId);
      }, 220);
    },
    [agentThreadsRefreshTimerRef, chatIdRef, refreshAgentThreads],
  );

  useEffect(() => {
    if (!selectedChatId) {
      agentThreadsRequestRef.current += 1;
      if (agentThreadsRefreshTimerRef.current) {
        clearTimeout(agentThreadsRefreshTimerRef.current);
        agentThreadsRefreshTimerRef.current = null;
      }
      setRelatedAgentThreads([]);
      setAgentRootThreadId(null);
      setLoadingAgentThreads(false);
      setAgentThreadMenuVisible(false);
      return;
    }

    void refreshAgentThreads(selectedChatId);
  }, [
    agentThreadsRefreshTimerRef,
    agentThreadsRequestRef,
    refreshAgentThreads,
    selectedChatId,
    setAgentRootThreadId,
    setAgentThreadMenuVisible,
    setLoadingAgentThreads,
    setRelatedAgentThreads,
  ]);

  useEffect(() => {
    if (!selectedChatId) {
      return;
    }

    const hasKnownRelatedAgentThreads =
      relatedAgentThreads.length > 0 || Boolean(agentRootThreadId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextRefresh = () => {
      if (stopped) {
        return;
      }

      const appIsActive = appStateRef.current === 'active';
      const shouldPollFast =
        appIsActive &&
        (hasKnownRelatedAgentThreads ||
          Boolean(activeTurnIdRef.current) ||
          runWatchdogUntilRef.current > Date.now());
      const intervalMs = !appIsActive
        ? AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS
        : shouldPollFast
          ? AGENT_THREADS_SYNC_INTERVAL_MS
          : AGENT_THREADS_IDLE_SYNC_INTERVAL_MS;

      timer = setTimeout(() => {
        const activeChatId = chatIdRef.current;
        if (activeChatId === selectedChatId) {
          void refreshAgentThreads(activeChatId);
        }
        scheduleNextRefresh();
      }, intervalMs);
    };

    scheduleNextRefresh();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [
    activeTurnIdRef,
    agentRootThreadId,
    appStateRef,
    chatIdRef,
    refreshAgentThreads,
    relatedAgentThreads.length,
    runWatchdogUntilRef,
    selectedChatId,
  ]);

  useEffect(
    () => () => {
      clearDeferredDisconnectActivity();
      clearForegroundAgentRefresh();
    },
    [clearDeferredDisconnectActivity, clearForegroundAgentRefresh],
  );

  return {
    refreshAgentThreads,
    scheduleAgentThreadsRefresh,
  };
}

export type MainScreenAgentThreadsRefreshResult = ReturnType<
  typeof useMainScreenAgentThreadsRefresh
>;
