import {
  activeTurnIdAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom
} from '../../state/mainScreen/turn';
import {
  relatedAgentThreadsAtom,
  workspaceBridgeRootAtom
} from '../../state/mainScreen/workspace';
import {
  activityAtom,
  heldActivityAtom,
  showDelayedGenericRunningActivityAtom
} from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useRef } from 'react';
import type { Chat } from '../../api/types';
import { GENERIC_RUNNING_ACTIVITY_DELAY_MS, GENERIC_RUNNING_ACTIVITY_TITLES, normalizeCloneDirectoryName, joinWorkspacePath } from './mainScreenHelpers';
import { areChatStatusMapsEquivalent } from './mainScreenChatState';
import { resolveDisplayedActivity, resolveVisibleActivity } from './mainScreenActivityIndicator';
import type { MainScreenUiActionHandlersContext, MainScreenUiActionHandlersResult } from './mainScreenUiActionHandlers';
import {
  gitCheckoutDirectoryNameAtom,
  gitCheckoutParentPathAtom,
} from '../../state/mainScreen/gitCheckout';






export type MainScreenHeaderActivityViewModelContext = MainScreenUiActionHandlersContext & MainScreenUiActionHandlersResult;

export function useMainScreenHeaderActivityViewModel(context: MainScreenHeaderActivityViewModelContext) {
  const {
    clearGenericRunningActivityDelay,
    genericRunningActivityTimeoutRef,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    isTurnLoading,
    preferredStartCwd,
    selectedChat,
    selectorAgentCount,
    showBridgeRecoveryBanner,
    turnFailureDetail,
    ws,
  } = context;
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const activeTurnId = useAtomValue(activeTurnIdAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const workspaceBridgeRoot = useAtomValue(workspaceBridgeRootAtom);
  const activity = useAtomValue(activityAtom);
  const heldActivity = useAtomValue(heldActivityAtom);
  const showDelayedGenericRunningActivity = useAtomValue(showDelayedGenericRunningActivityAtom);
  const setShowDelayedGenericRunningActivity = useSetAtom(showDelayedGenericRunningActivityAtom);
  const gitCheckoutDirectoryName = useAtomValue(gitCheckoutDirectoryNameAtom);
  const gitCheckoutParentPath = useAtomValue(gitCheckoutParentPathAtom);

  const indicatorInputs = {
    activity,
    heldActivity,
    isConnected: ws.isConnected,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    pendingApproval,
    pendingUserInputRequest,
    selectedChatStatus: selectedChat?.status ?? null,
    showBridgeRecoveryBanner,
    turnFailureDetail,
  };
  const visibleActivity = resolveVisibleActivity(indicatorInputs);
  const displayedActivity = resolveDisplayedActivity(indicatorInputs);
  const isGenericRunningActivity =
    displayedActivity.tone === 'running' &&
    !displayedActivity.detail &&
    GENERIC_RUNNING_ACTIVITY_TITLES.has(displayedActivity.title.trim().toLowerCase());
  const shouldShowGenericRunningActivityImmediately =
    isGenericRunningActivity && (isTurnLoading || Boolean(activeTurnId));

  useEffect(() => {
    if (!isGenericRunningActivity) {
      clearGenericRunningActivityDelay();
      return;
    }

    if (shouldShowGenericRunningActivityImmediately) {
      if (genericRunningActivityTimeoutRef.current) {
        clearTimeout(genericRunningActivityTimeoutRef.current);
        genericRunningActivityTimeoutRef.current = null;
      }
      if (!showDelayedGenericRunningActivity) {
        setShowDelayedGenericRunningActivity(true);
      }
      return;
    }

    if (showDelayedGenericRunningActivity || genericRunningActivityTimeoutRef.current) {
      return;
    }

    genericRunningActivityTimeoutRef.current = setTimeout(() => {
      genericRunningActivityTimeoutRef.current = null;
      setShowDelayedGenericRunningActivity(true);
    }, GENERIC_RUNNING_ACTIVITY_DELAY_MS);

    return () => {
      if (genericRunningActivityTimeoutRef.current) {
        clearTimeout(genericRunningActivityTimeoutRef.current);
        genericRunningActivityTimeoutRef.current = null;
      }
    };
  }, [
    clearGenericRunningActivityDelay,
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately,
    showDelayedGenericRunningActivity,
    isTurnLoading,
    activeTurnId,
  ]);

  const activityDetail = displayedActivity.detail;
  const showActivity =
    (isLoading && !isGenericRunningActivity) ||
    isOpeningChat ||
    (displayedActivity.tone !== 'idle' &&
      (!isGenericRunningActivity || showDelayedGenericRunningActivity)) ||
    Boolean(activityDetail);
  const headerTitle = isOpeningChat ? 'Opening chat' : selectedChat?.title?.trim() || 'New chat';
  const defaultStartWorkspaceLabel =
    preferredStartCwd ?? 'Select project';
  const gitCheckoutDestinationLabel =
    gitCheckoutParentPath ?? workspaceBridgeRoot ?? 'Bridge default workspace';
  const gitCheckoutTargetPath =
    gitCheckoutParentPath && normalizeCloneDirectoryName(gitCheckoutDirectoryName)
      ? joinWorkspacePath(
          gitCheckoutParentPath,
          normalizeCloneDirectoryName(gitCheckoutDirectoryName) ?? ''
        )
      : null;
  const spawnedAgentCount = selectorAgentCount;
  const selectedChatIsSubAgent = Boolean(selectedChat?.parentThreadId);
  const showAgentThreadChip =
    !isOpeningChat &&
    Boolean(selectedChat) &&
    (spawnedAgentCount > 0 || selectedChatIsSubAgent);
  const agentThreadChipLabel = selectedChatIsSubAgent
    ? spawnedAgentCount > 1
      ? `Sub-agent · ${String(spawnedAgentCount)} threads`
      : 'Sub-agent'
    : spawnedAgentCount === 1
      ? '1 agent'
      : `${String(spawnedAgentCount)} agents`;
  const agentThreadStatusByIdRef = useRef<ReadonlyMap<string, Chat['status']>>(new Map());
  const agentThreadStatusById = useMemo(() => {
    const nextMap = new Map(relatedAgentThreads.map((chat) => [chat.id, chat.status] as const));
    const previousMap = agentThreadStatusByIdRef.current;
    if (areChatStatusMapsEquivalent(previousMap, nextMap)) {
      return previousMap;
    }
    agentThreadStatusByIdRef.current = nextMap;
    return nextMap;
  }, [relatedAgentThreads]);

  return {
    visibleActivity,
    displayedActivity,
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately,
    activityDetail,
    showActivity,
    headerTitle,
    defaultStartWorkspaceLabel,
    gitCheckoutDestinationLabel,
    gitCheckoutTargetPath,
    spawnedAgentCount,
    selectedChatIsSubAgent,
    showAgentThreadChip,
    agentThreadChipLabel,
    agentThreadStatusByIdRef,
    agentThreadStatusById,
  };
}

export type MainScreenHeaderActivityViewModelResult = ReturnType<typeof useMainScreenHeaderActivityViewModel>;
