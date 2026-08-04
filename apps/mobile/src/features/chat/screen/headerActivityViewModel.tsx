import { activeTurnIdAtom, pendingApprovalAtom, pendingUserInputRequestAtom } from '../state/turn';
import { relatedAgentThreadsAtom, workspaceBridgeRootAtom } from '../../workspace/state/workspace';
import {
  activityAtom,
  heldActivityAtom,
  showDelayedGenericRunningActivityAtom,
} from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useRef } from 'react';
import type { Chat, ChatSummary } from '@bridge/types/types';
import {
  GENERIC_RUNNING_ACTIVITY_DELAY_MS,
  GENERIC_RUNNING_ACTIVITY_TITLES,
  normalizeCloneDirectoryName,
  joinWorkspacePath,
  resolveRotatingWorkingPhrase,
  type RotatingWorkingPhrase,
} from '../helpers/helpers';
import { areChatStatusMapsEquivalent } from '../state/chatState';
import {
  resolveDisplayedActivity,
  resolveVisibleActivity,
  type ActivityIndicatorInputs,
} from './activityIndicator';
import type {
  MainScreenUiActionHandlersContext,
  MainScreenUiActionHandlersResult,
} from './uiActionHandlers';
import {
  gitCheckoutDirectoryNameAtom,
  gitCheckoutParentPathAtom,
} from '../../workspace/state/gitCheckout';

export type MainScreenHeaderActivityViewModelContext = MainScreenUiActionHandlersContext &
  MainScreenUiActionHandlersResult;

interface GenericRunningActivityState {
  isGenericRunningActivity: boolean;
  shouldShowGenericRunningActivityImmediately: boolean;
}

interface AgentThreadChipState {
  spawnedAgentCount: number;
  selectedChatIsSubAgent: boolean;
  showAgentThreadChip: boolean;
  agentThreadChipLabel: string;
}

function buildActivityIndicatorInputs(
  activity: ActivityIndicatorInputs['activity'],
  heldActivity: ActivityIndicatorInputs['heldActivity'],
  isConnected: boolean,
  isLoading: boolean,
  isOpeningChat: boolean,
  isTurnLikelyRunning: boolean,
  pendingApproval: ActivityIndicatorInputs['pendingApproval'],
  pendingUserInputRequest: ActivityIndicatorInputs['pendingUserInputRequest'],
  selectedChatStatus: ActivityIndicatorInputs['selectedChatStatus'],
  showBridgeRecoveryBanner: boolean,
  turnFailureDetail: string | null,
): ActivityIndicatorInputs {
  return {
    activity,
    heldActivity,
    isConnected,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    pendingApproval,
    pendingUserInputRequest,
    selectedChatStatus,
    showBridgeRecoveryBanner,
    turnFailureDetail,
  };
}

function resolveGenericRunningActivityState(
  displayedActivity: ReturnType<typeof resolveDisplayedActivity>,
  isTurnLoading: boolean,
  activeTurnId: string | null,
): GenericRunningActivityState {
  const isGenericRunningActivity =
    displayedActivity.tone === 'running' &&
    !displayedActivity.detail &&
    GENERIC_RUNNING_ACTIVITY_TITLES.has(displayedActivity.title.trim().toLowerCase());

  return {
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately:
      isGenericRunningActivity && (isTurnLoading || Boolean(activeTurnId)),
  };
}

/**
 * Identifies the chat state a working phrase was picked for. The turn, the last chat update and
 * the underlying generic title all move the chat on, so any of them earns a fresh phrase while
 * re-renders in between keep the strip still.
 */
function resolveWorkingPhraseKey(
  activeTurnId: string | null,
  chatUpdatedAt: string | null,
  title: string,
): string {
  return `${activeTurnId ?? ''}|${chatUpdatedAt ?? ''}|${title.trim().toLowerCase()}`;
}

function useRotatingWorkingTitle(
  isGenericRunningActivity: boolean,
  activeTurnId: string | null,
  chatUpdatedAt: string | null,
  title: string,
): string | null {
  const phraseRef = useRef<RotatingWorkingPhrase | null>(null);
  return useMemo(() => {
    const next = resolveRotatingWorkingPhrase(phraseRef.current, {
      isGenericRunningActivity,
      key: resolveWorkingPhraseKey(activeTurnId, chatUpdatedAt, title),
    });
    phraseRef.current = next;
    return next?.phrase ?? null;
  }, [activeTurnId, chatUpdatedAt, isGenericRunningActivity, title]);
}

function resolveShowActivity(
  displayedActivity: ReturnType<typeof resolveDisplayedActivity>,
  activityDetail: string | undefined,
  isLoading: boolean,
  isOpeningChat: boolean,
  isGenericRunningActivity: boolean,
  showDelayedGenericRunningActivity: boolean,
): boolean {
  if (isLoading && !isGenericRunningActivity) {
    return true;
  }
  if (isOpeningChat) {
    return true;
  }
  if (activityDetail) {
    return true;
  }
  if (displayedActivity.tone === 'idle') {
    return false;
  }
  return !isGenericRunningActivity || showDelayedGenericRunningActivity;
}

function resolveGitCheckoutTargetPath(
  gitCheckoutParentPath: string | null,
  gitCheckoutDirectoryName: string | null,
): string | null {
  const normalizedDirectoryName = normalizeCloneDirectoryName(gitCheckoutDirectoryName);
  if (!gitCheckoutParentPath || !normalizedDirectoryName) {
    return null;
  }
  return joinWorkspacePath(gitCheckoutParentPath, normalizedDirectoryName);
}

function resolveAgentThreadChipLabel(
  selectedChatIsSubAgent: boolean,
  spawnedAgentCount: number,
): string {
  if (selectedChatIsSubAgent) {
    return spawnedAgentCount > 1 ? `Sub-agent · ${String(spawnedAgentCount)} threads` : 'Sub-agent';
  }
  return spawnedAgentCount === 1 ? '1 agent' : `${String(spawnedAgentCount)} agents`;
}

function resolveAgentThreadChipState(
  selectedChat: Chat | null,
  relatedAgentThreads: readonly ChatSummary[],
  selectorAgentCount: number,
  isOpeningChat: boolean,
): AgentThreadChipState {
  const relatedThreadsMatchSelectedChat = Boolean(
    selectedChat && relatedAgentThreads.some((chat) => chat.id === selectedChat.id),
  );
  const spawnedAgentCount = relatedThreadsMatchSelectedChat ? selectorAgentCount : 0;
  const selectedChatIsSubAgent = Boolean(selectedChat?.parentThreadId);
  const showAgentThreadChip =
    !isOpeningChat && Boolean(selectedChat) && (spawnedAgentCount > 0 || selectedChatIsSubAgent);

  return {
    spawnedAgentCount,
    selectedChatIsSubAgent,
    showAgentThreadChip,
    agentThreadChipLabel: resolveAgentThreadChipLabel(selectedChatIsSubAgent, spawnedAgentCount),
  };
}

function resolveAgentThreadStatusMap(
  previousMap: ReadonlyMap<string, Chat['status']>,
  relatedAgentThreads: readonly ChatSummary[],
): ReadonlyMap<string, Chat['status']> {
  const nextMap = new Map(relatedAgentThreads.map((chat) => [chat.id, chat.status] as const));
  return areChatStatusMapsEquivalent(previousMap, nextMap) ? previousMap : nextMap;
}

export function useMainScreenHeaderActivityViewModel(
  context: MainScreenHeaderActivityViewModelContext,
) {
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

  const indicatorInputs = buildActivityIndicatorInputs(
    activity,
    heldActivity,
    ws.isConnected,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    pendingApproval,
    pendingUserInputRequest,
    selectedChat?.status ?? null,
    showBridgeRecoveryBanner,
    turnFailureDetail,
  );
  const visibleActivity = resolveVisibleActivity(indicatorInputs);
  const resolvedActivity = resolveDisplayedActivity(indicatorInputs);
  const { isGenericRunningActivity, shouldShowGenericRunningActivityImmediately } =
    resolveGenericRunningActivityState(resolvedActivity, isTurnLoading, activeTurnId);
  const rotatingWorkingTitle = useRotatingWorkingTitle(
    isGenericRunningActivity,
    activeTurnId,
    selectedChat?.updatedAt ?? null,
    resolvedActivity.title,
  );
  const displayedActivity = rotatingWorkingTitle
    ? { ...resolvedActivity, title: rotatingWorkingTitle }
    : resolvedActivity;

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
    genericRunningActivityTimeoutRef,
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately,
    showDelayedGenericRunningActivity,
    isTurnLoading,
    activeTurnId,
    setShowDelayedGenericRunningActivity,
  ]);

  const activityDetail = displayedActivity.detail;
  const showActivity = resolveShowActivity(
    displayedActivity,
    activityDetail,
    isLoading,
    isOpeningChat,
    isGenericRunningActivity,
    showDelayedGenericRunningActivity,
  );
  const headerTitle = isOpeningChat ? 'Opening chat' : selectedChat?.title?.trim() || 'New chat';
  const defaultStartWorkspaceLabel = preferredStartCwd ?? 'Select project';
  const gitCheckoutDestinationLabel =
    gitCheckoutParentPath ?? workspaceBridgeRoot ?? 'Bridge default workspace';
  const gitCheckoutTargetPath = resolveGitCheckoutTargetPath(
    gitCheckoutParentPath,
    gitCheckoutDirectoryName,
  );
  const { spawnedAgentCount, selectedChatIsSubAgent, showAgentThreadChip, agentThreadChipLabel } =
    resolveAgentThreadChipState(
      selectedChat,
      relatedAgentThreads,
      selectorAgentCount,
      isOpeningChat,
    );
  const agentThreadStatusByIdRef = useRef<ReadonlyMap<string, Chat['status']>>(new Map());
  const agentThreadStatusById = useMemo(() => {
    const nextMap = resolveAgentThreadStatusMap(
      agentThreadStatusByIdRef.current,
      relatedAgentThreads,
    );
    agentThreadStatusByIdRef.current = nextMap;
    return nextMap;
  }, [relatedAgentThreads]);

  return {
    visibleActivity,
    displayedActivity,
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately,
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

export type MainScreenHeaderActivityViewModelResult = ReturnType<
  typeof useMainScreenHeaderActivityViewModel
>;
