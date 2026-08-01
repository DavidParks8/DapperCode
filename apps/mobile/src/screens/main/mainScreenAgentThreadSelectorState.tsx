import { errorAtom } from '../../state/mainScreen/turn';
import {
  agentRootThreadIdAtom,
  agentRuntimeRevisionAtom,
  relatedAgentThreadsAtom,
} from '../../state/mainScreen/workspace';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import type { Chat } from '../../api/types';
import { type SelectionSheetOption } from '../../components/SelectionSheet';
import { mainScreenCommandsAtom } from '../../state/commands';
import {
  describeAgentThreadSource,
  findMatchingAgentThread,
  indexAgentThreadOrdinals,
  resolveAgentActivitySummary,
} from './agentThreads';
import { buildAgentThreadDisplayState } from './agentThreadDisplay';
import { formatAgentThreadOptionTitle, iconForAgentThread } from './mainScreenHelpers';
import type {
  MainScreenChatNavigationContext,
  MainScreenChatNavigationResult,
} from './mainScreenChatNavigation';
import { agentThreadMenuVisibleAtom } from '../../state/mainScreen/modals';
import { currentNavigationRouteAtom } from '../../state/navigation/atoms';

export type MainScreenAgentThreadSelectorStateContext =
  MainScreenChatNavigationContext & MainScreenChatNavigationResult;

export function useMainScreenAgentThreadSelectorState(
  context: MainScreenAgentThreadSelectorStateContext,
) {
  const {
    chatIdRef,
    closeAgentDetail,
    onPendingOpenChatHandled,
    openAgentDetail,
    openAgentThreadSelectorRef,
    openChatThread,
    pendingOpenChatId,
    pendingOpenChatSnapshot,
    refreshAgentThreads,
    runWatchdogNow,
    selectedChatRef,
    startNewChat,
    threadRuntimeSnapshotsRef,
  } = context;
  const setError = useSetAtom(errorAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const agentRootThreadId = useAtomValue(agentRootThreadIdAtom);
  const agentRuntimeRevision = useAtomValue(agentRuntimeRevisionAtom);
  const currentNavigationRoute = useAtomValue(currentNavigationRouteAtom);
  const agentDetailThreadId =
    currentNavigationRoute.screen === 'SubAgent' ? currentNavigationRoute.threadId : null;
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);

  const openAgentThreadSelector = useCallback(
    async (query?: string | null): Promise<boolean> => {
      const focusChat = selectedChatRef.current;
      if (!focusChat?.id) {
        setError('Open a chat before switching agent threads.');
        return false;
      }

      const related = await refreshAgentThreads(focusChat.id, { showLoading: true });
      if (chatIdRef.current !== focusChat.id) {
        return false;
      }
      if (related.threads.length <= 1) {
        setAgentThreadMenuVisible(false);
        setError('No spawned agent threads for this chat yet.');
        return true;
      }

      const normalizedQuery = query?.trim() ?? '';
      if (!normalizedQuery) {
        setError(null);
        setAgentThreadMenuVisible(true);
        return true;
      }

      const match = findMatchingAgentThread(related.threads, normalizedQuery);
      if (!match) {
        setError(`No agent thread matched "${normalizedQuery}".`);
        setAgentThreadMenuVisible(true);
        return true;
      }

      setAgentThreadMenuVisible(false);
      if (match.id === agentRootThreadId) {
        closeAgentDetail();
      } else {
        openAgentDetail(match.id);
      }
      return true;
    },
    [agentRootThreadId, chatIdRef, closeAgentDetail, openAgentDetail, refreshAgentThreads],
  );
  openAgentThreadSelectorRef.current = openAgentThreadSelector;

  const agentThreadOrdinals = useMemo(
    () => indexAgentThreadOrdinals(relatedAgentThreads, agentRootThreadId),
    [agentRootThreadId, relatedAgentThreads],
  );
  const agentThreadRows = useMemo(() => {
    return relatedAgentThreads.map((chat) => {
      const isRootThread = Boolean(agentRootThreadId) && chat.id === agentRootThreadId;
      const ordinal = agentThreadOrdinals.get(chat.id) ?? null;
      const snapshot = threadRuntimeSnapshotsRef.current[chat.id] ?? null;
      const runtime = buildAgentThreadDisplayState(chat, snapshot, runWatchdogNow);
      const latestCommand = snapshot?.latestCommand ?? snapshot?.activeCommands?.at(-1) ?? null;

      return {
        chat,
        isRootThread,
        ordinal,
        title: formatAgentThreadOptionTitle(chat, agentRootThreadId, ordinal),
        description: resolveAgentActivitySummary({
          runtimeDetail: runtime.detail,
          latestCommandDetail: latestCommand?.detail,
          role: chat.agentRole,
          preview: chat.lastMessagePreview,
          sourceDescription: describeAgentThreadSource(chat, agentRootThreadId),
        }),
        latestCommand,
        runtime,
        selected: chat.id === agentDetailThreadId,
      };
    });
  }, [
    agentRootThreadId,
    agentThreadOrdinals,
    agentRuntimeRevision,
    relatedAgentThreads,
    runWatchdogNow,
    agentDetailThreadId,
  ]);

  const selectorAgentCount = useMemo(
    () => agentThreadRows.filter((row) => !row.isRootThread).length,
    [agentThreadRows],
  );

  const agentThreadMenuOptions = useMemo<SelectionSheetOption[]>(() => {
    return agentThreadRows.map((row) => {
      const { chat, description, isRootThread, runtime } = row;
      return {
        key: chat.id,
        title: row.title,
        description,
        badge: isRootThread
          ? 'Main'
          : chat.subAgentDepth
            ? `D${String(chat.subAgentDepth)}`
            : undefined,
        badgeBackgroundColor: isRootThread ? undefined : runtime.statusSurfaceColor,
        badgeTextColor: isRootThread ? undefined : runtime.accentColor,
        meta: runtime.label,
        metaColor: runtime.statusColor,
        icon: isRootThread ? iconForAgentThread(chat, agentRootThreadId) : runtime.icon,
        iconColor: isRootThread ? undefined : runtime.accentColor,
        titleColor: isRootThread ? undefined : runtime.accentColor,
        selected: row.selected,
        onPress: () => {
          setAgentThreadMenuVisible(false);
          if (isRootThread) {
            closeAgentDetail();
          } else {
            openAgentDetail(chat.id);
          }
        },
      } satisfies SelectionSheetOption;
    });
  }, [agentRootThreadId, agentThreadRows, closeAgentDetail, openAgentDetail]);

  const setMainScreenCommands = useSetAtom(mainScreenCommandsAtom);
  useEffect(() => {
    setMainScreenCommands({
      openChat: (id: string, optimisticChat?: Chat | null) => {
        closeAgentDetail();
        openChatThread(id, optimisticChat);
      },
      startNewChat: () => {
        closeAgentDetail();
        startNewChat();
      },
    });
    return () => {
      setMainScreenCommands(null);
    };
  }, [closeAgentDetail, openChatThread, setMainScreenCommands, startNewChat]);

  useLayoutEffect(() => {
    if (!pendingOpenChatId) {
      return;
    }

    const snapshot =
      pendingOpenChatSnapshot && pendingOpenChatSnapshot.id === pendingOpenChatId
        ? pendingOpenChatSnapshot
        : null;

    openChatThread(pendingOpenChatId, snapshot);
    onPendingOpenChatHandled?.();
  }, [onPendingOpenChatHandled, openChatThread, pendingOpenChatId, pendingOpenChatSnapshot]);

  return {
    openAgentThreadSelector,
    agentThreadRows,
    selectorAgentCount,
    agentThreadMenuOptions,
  };
}

export type MainScreenAgentThreadSelectorStateResult = ReturnType<
  typeof useMainScreenAgentThreadSelectorState
>;
