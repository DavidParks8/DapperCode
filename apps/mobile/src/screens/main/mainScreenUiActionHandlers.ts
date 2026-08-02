import {
  activeBridgeUiSurfacesAtom,
  activeTurnIdAtom,
  creatingAtom,
  errorAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  sendingAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import { relatedAgentThreadsAtom } from '../../state/mainScreen/workspace';
import {
  activityAtom,
  bridgeRecoveryBannerVisibleAtom,
  heldActivityAtom,
} from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { BridgeUiAction, BridgeUiSurface, ChatSummary } from '../../api/types';
import {
  ACTIVITY_DETAIL_HOLD_MS,
  type ActivityState,
  isThreadOrSubAgentRunning,
  removeBridgeUiSurfaceFromList,
  resolveHeldActivity,
} from './mainScreenHelpers';
import type {
  MainScreenApprovalAndUserInputResolutionContext,
  MainScreenApprovalAndUserInputResolutionResult,
} from './mainScreenApprovalAndUserInputResolution';

export type MainScreenUiActionHandlersContext = MainScreenApprovalAndUserInputResolutionContext &
  MainScreenApprovalAndUserInputResolutionResult;

function resolveUiActionFlags(options: {
  selectedChat: MainScreenUiActionHandlersContext['selectedChat'];
  openingChatId: MainScreenUiActionHandlersContext['openingChatId'];
  sending: boolean;
  creating: boolean;
  uploadingAttachment: boolean;
  activeTurnId: string | null;
  relatedAgentThreads: readonly ChatSummary[];
  runWatchdogUntilRef: MainScreenUiActionHandlersContext['runWatchdogUntilRef'];
  runWatchdogNow: number;
}) {
  const isTurnLoading = options.sending || options.creating;
  const isLoading = isTurnLoading || options.uploadingAttachment;
  const isOpeningChat = Boolean(options.openingChatId);
  const shouldShowComposer = !isOpeningChat;
  const isTurnLikelyRunning =
    Boolean(options.activeTurnId) ||
    isThreadOrSubAgentRunning(options.selectedChat, options.relatedAgentThreads);
  const hasRunWatchdog = options.runWatchdogUntilRef.current > options.runWatchdogNow;

  return {
    isTurnLoading,
    isLoading,
    isOpeningChat,
    shouldShowComposer,
    isTurnLikelyRunning,
    hasRunWatchdog,
  };
}

function shouldSettleRunningActivity(options: {
  activityTone: ActivityState['tone'];
  isLoading: boolean;
  isOpeningChat: boolean;
  pendingApproval: unknown;
  pendingUserInputRequest: unknown;
  isTurnLikelyRunning: boolean;
  hasRunWatchdog: boolean;
}): boolean {
  return (
    options.activityTone === 'running' &&
    !options.isLoading &&
    !options.isOpeningChat &&
    !options.pendingApproval &&
    !options.pendingUserInputRequest &&
    !options.isTurnLikelyRunning &&
    !options.hasRunWatchdog
  );
}

function resolveSettledRunningActivity(
  selectedChat: MainScreenUiActionHandlersContext['selectedChat'],
): ActivityState {
  if (selectedChat?.status === 'complete') {
    return {
      tone: 'complete',
      title: 'Turn completed',
    };
  }

  return {
    tone: 'idle',
    title: 'Ready',
  };
}

function resolveTurnFailureDetail(
  error: string | null,
  selectedChat: MainScreenUiActionHandlersContext['selectedChat'],
  activity: ActivityState,
): string | null {
  return (
    error?.trim() ||
    (selectedChat?.status === 'error' ? (selectedChat.lastError?.trim() ?? null) : null) ||
    (activity.tone === 'error' ? (activity.detail?.trim() ?? null) : null)
  );
}

export function useMainScreenUiActionHandlers(context: MainScreenUiActionHandlersContext) {
  const {
    api,
    approvalController,
    cacheThreadPendingUserInputRequest,
    clearHeldActivity,
    createChat,
    heldActivityTimeoutRef,
    onOpenGit,
    openingChatId,
    removeThreadBridgeUiSurface,
    runWatchdogNow,
    runWatchdogUntilRef,
    scrollToBottomReliable,
    selectedChat,
    sendMessage,
    uploadingAttachment,
    ws,
  } = context;
  const sending = useAtomValue(sendingAtom);
  const creating = useAtomValue(creatingAtom);
  const error = useAtomValue(errorAtom);
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const resolvingUserInput = useAtomValue(resolvingUserInputAtom);
  const activeTurnId = useAtomValue(activeTurnIdAtom);
  const setError = useSetAtom(errorAtom);
  const setPendingUserInputRequest = useSetAtom(pendingUserInputRequestAtom);
  const setUserInputDrafts = useSetAtom(userInputDraftsAtom);
  const setUserInputError = useSetAtom(userInputErrorAtom);
  const setResolvingUserInput = useSetAtom(resolvingUserInputAtom);
  const setActiveBridgeUiSurfaces = useSetAtom(activeBridgeUiSurfacesAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const activity = useAtomValue(activityAtom);
  const bridgeRecoveryBannerVisible = useAtomValue(bridgeRecoveryBannerVisibleAtom);
  const setActivity = useSetAtom(activityAtom);
  const setHeldActivity = useSetAtom(heldActivityAtom);

  const dismissUserInputRequest = useCallback(
    async (action: 'decline' | 'cancel') => {
      if (!pendingUserInputRequest || resolvingUserInput) {
        return;
      }
      setResolvingUserInput(true);
      try {
        await approvalController.dismissUserInput(pendingUserInputRequest, action);
        cacheThreadPendingUserInputRequest(pendingUserInputRequest.threadId, null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setUserInputError(null);
      } catch (err) {
        setUserInputError((err as Error).message);
      } finally {
        setResolvingUserInput(false);
      }
    },
    [
      approvalController,
      cacheThreadPendingUserInputRequest,
      pendingUserInputRequest,
      resolvingUserInput,
      setPendingUserInputRequest,
      setResolvingUserInput,
      setUserInputDrafts,
      setUserInputError,
    ],
  );

  const dismissBridgeUiSurface = useCallback(
    async (surface: BridgeUiSurface) => {
      removeThreadBridgeUiSurface(surface.id, surface.threadId);
      setActiveBridgeUiSurfaces((previous) => removeBridgeUiSurfaceFromList(previous, surface.id));
      try {
        await api.dismissBridgeUiSurface(surface.id, surface.threadId);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api, removeThreadBridgeUiSurface, setActiveBridgeUiSurfaces, setError],
  );

  const handleBridgeUiAction = useCallback(
    async (surface: BridgeUiSurface, action: BridgeUiAction) => {
      try {
        await api.resolveBridgeUiSurface(surface.id, {
          threadId: surface.threadId,
          turnId: surface.turnId ?? null,
          actionId: action.id,
        });
        if (action.dismissesSurface !== false) {
          removeThreadBridgeUiSurface(surface.id, surface.threadId);
          setActiveBridgeUiSurfaces((previous) =>
            removeBridgeUiSurfaceFromList(previous, surface.id),
          );
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api, removeThreadBridgeUiSurface, setActiveBridgeUiSurfaces, setError],
  );

  const handleOpenGit = useCallback(() => {
    if (!selectedChat) {
      return;
    }
    onOpenGit(selectedChat);
  }, [onOpenGit, selectedChat]);

  const handleComposerFocus = useCallback(() => {
    requestAnimationFrame(() => {
      scrollToBottomReliable(true);
    });
  }, [scrollToBottomReliable]);

  const handleSubmit = selectedChat ? sendMessage : createChat;
  const {
    isTurnLoading,
    isLoading,
    isOpeningChat,
    shouldShowComposer,
    isTurnLikelyRunning,
    hasRunWatchdog,
  } = resolveUiActionFlags({
    selectedChat,
    openingChatId,
    sending,
    creating,
    uploadingAttachment,
    activeTurnId,
    relatedAgentThreads,
    runWatchdogUntilRef,
    runWatchdogNow,
  });
  useEffect(() => {
    const nextHeldActivity = resolveHeldActivity({
      tone: activity.tone,
      title: activity.title,
      detail: activity.detail,
    });
    if (!nextHeldActivity) {
      // A terminal or idle status supersedes whatever was being held, otherwise the
      // stale running title reappears once the turn stops running.
      if (activity.tone !== 'running') {
        clearHeldActivity();
      }
      return;
    }

    setHeldActivity(nextHeldActivity);
    if (heldActivityTimeoutRef.current) {
      clearTimeout(heldActivityTimeoutRef.current);
    }
    heldActivityTimeoutRef.current = setTimeout(() => {
      heldActivityTimeoutRef.current = null;
      setHeldActivity(null);
    }, ACTIVITY_DETAIL_HOLD_MS);
  }, [
    activity.detail,
    activity.title,
    activity.tone,
    clearHeldActivity,
    heldActivityTimeoutRef,
    setHeldActivity,
  ]);

  useEffect(() => {
    clearHeldActivity();
  }, [clearHeldActivity, heldActivityTimeoutRef, openingChatId, selectedChat?.id]);

  useEffect(
    () => () => {
      if (heldActivityTimeoutRef.current) {
        clearTimeout(heldActivityTimeoutRef.current);
        heldActivityTimeoutRef.current = null;
      }
    },
    [heldActivityTimeoutRef],
  );

  useEffect(() => {
    if (
      !shouldSettleRunningActivity({
        activityTone: activity.tone,
        isLoading,
        isOpeningChat,
        pendingApproval,
        pendingUserInputRequest,
        isTurnLikelyRunning,
        hasRunWatchdog,
      })
    ) {
      return;
    }

    setActivity((prev) => {
      if (prev.tone !== 'running') {
        return prev;
      }
      return resolveSettledRunningActivity(selectedChat);
    });
  }, [
    activity.tone,
    hasRunWatchdog,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    pendingApproval,
    pendingUserInputRequest,
    selectedChat,
    setActivity,
  ]);

  const showBridgeRecoveryBanner = bridgeRecoveryBannerVisible && !ws.isConnected;
  const turnFailureDetail = resolveTurnFailureDetail(error, selectedChat, activity);

  return {
    dismissUserInputRequest,
    dismissBridgeUiSurface,
    handleBridgeUiAction,
    handleOpenGit,
    handleComposerFocus,
    handleSubmit,
    isTurnLoading,
    isLoading,
    isOpeningChat,
    shouldShowComposer,
    isTurnLikelyRunning,
    hasRunWatchdog,
    showBridgeRecoveryBanner,
    turnFailureDetail,
  };
}

export type MainScreenUiActionHandlersResult = ReturnType<typeof useMainScreenUiActionHandlers>;
