import {
  relatedAgentThreadsAtom
} from '../state/mainScreen/workspace';
import {
  activityAtom,
  bridgeRecoveryBannerVisibleAtom,
  heldActivityAtom
} from '../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { BridgeUiAction, BridgeUiSurface } from '../api/types';
import { ACTIVITY_DETAIL_HOLD_MS, isThreadOrSubAgentRunning, removeBridgeUiSurfaceFromList, resolveHeldActivity } from './mainScreenHelpers';
import type { MainScreenApprovalAndUserInputResolutionContext, MainScreenApprovalAndUserInputResolutionResult } from './mainScreenApprovalAndUserInputResolution';






export type MainScreenUiActionHandlersContext = MainScreenApprovalAndUserInputResolutionContext & MainScreenApprovalAndUserInputResolutionResult;

export function useMainScreenUiActionHandlers(context: MainScreenUiActionHandlersContext) {
  const {
    activeTurnId,
    api,
    approvalController,
    cacheThreadPendingUserInputRequest,
    clearHeldActivity,
    createChat,
    creating,
    error,
    heldActivityTimeoutRef,
    onOpenGit,
    openingChatId,
    pendingApproval,
    pendingUserInputRequest,
    removeThreadBridgeUiSurface,
    resolvingUserInput,
    runWatchdogNow,
    runWatchdogUntilRef,
    scrollToBottomReliable,
    selectedChat,
    sendMessage,
    sending,
    setActiveBridgeUiSurfaces,
    setError,
    setPendingUserInputRequest,
    setResolvingUserInput,
    setUserInputDrafts,
    setUserInputError,
    uploadingAttachment,
    ws,
  } = context;
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const activity = useAtomValue(activityAtom);
  const bridgeRecoveryBannerVisible = useAtomValue(bridgeRecoveryBannerVisibleAtom);
  const setActivity = useSetAtom(activityAtom);
  const setHeldActivity = useSetAtom(heldActivityAtom);


  const dismissUserInputRequest = useCallback(
    async (action: 'decline' | 'cancel') => {
      if (!pendingUserInputRequest || resolvingUserInput) return;
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
    ]
  );

  const dismissBridgeUiSurface = useCallback(
    async (surface: BridgeUiSurface) => {
      removeThreadBridgeUiSurface(surface.id, surface.threadId);
      setActiveBridgeUiSurfaces((previous) =>
        removeBridgeUiSurfaceFromList(previous, surface.id)
      );
      try {
        await api.dismissBridgeUiSurface(surface.id, surface.threadId);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api, removeThreadBridgeUiSurface]
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
            removeBridgeUiSurfaceFromList(previous, surface.id)
          );
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api, removeThreadBridgeUiSurface]
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
  const isTurnLoading = sending || creating;
  const isLoading = isTurnLoading || uploadingAttachment;
  const isOpeningChat = Boolean(openingChatId);
  const shouldShowComposer = !isOpeningChat;
  const isTurnLikelyRunning =
    Boolean(activeTurnId) || isThreadOrSubAgentRunning(selectedChat, relatedAgentThreads);
  const hasRunWatchdog = runWatchdogUntilRef.current > runWatchdogNow;

  useEffect(() => {
    const nextHeldActivity = resolveHeldActivity(activity);
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
  }, [activity.detail, activity.title, activity.tone]);

  useEffect(() => {
    clearHeldActivity();
  }, [clearHeldActivity, openingChatId, selectedChat?.id]);

  useEffect(
    () => () => {
      if (heldActivityTimeoutRef.current) {
        clearTimeout(heldActivityTimeoutRef.current);
        heldActivityTimeoutRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (
      activity.tone !== 'running' ||
      isLoading ||
      isOpeningChat ||
      pendingApproval ||
      pendingUserInputRequest ||
      isTurnLikelyRunning ||
      hasRunWatchdog
    ) {
      return;
    }

    setActivity((prev) => {
      if (prev.tone !== 'running') {
        return prev;
      }

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
  ]);

  const showBridgeRecoveryBanner = bridgeRecoveryBannerVisible && !ws.isConnected;
  const turnFailureDetail =
    error?.trim() ||
    (selectedChat?.status === 'error' ? selectedChat.lastError?.trim() ?? null : null) ||
    (activity.tone === 'error' ? activity.detail?.trim() ?? null : null);

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
