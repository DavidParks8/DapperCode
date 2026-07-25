import type { Chat } from '../api/types';
import { type ActivityState, isBridgeRecoveryActivity } from './mainScreenHelpers';

export interface ActivityIndicatorInputs {
  activity: ActivityState;
  heldActivity: ActivityState | null;
  isConnected: boolean;
  isLoading: boolean;
  isOpeningChat: boolean;
  isTurnLikelyRunning: boolean;
  pendingApproval: { command?: string | null; kind?: string | null } | null;
  pendingUserInputRequest: unknown | null;
  selectedChatStatus: Chat['status'] | null;
  showBridgeRecoveryBanner: boolean;
  turnFailureDetail: string | null;
}

/**
 * The status the header would report for these inputs, before the disconnected
 * bridge is taken into account.
 *
 * Extracted from the header hook so the indicator can be asserted at each step of
 * a sequence rather than only at the end of a rendered turn.
 */
export function resolveVisibleActivity(inputs: ActivityIndicatorInputs): ActivityState {
  const {
    activity,
    heldActivity,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    pendingApproval,
    pendingUserInputRequest,
    selectedChatStatus,
    turnFailureDetail,
  } = inputs;

  if (isOpeningChat) {
    return { tone: 'running', title: 'Opening chat' };
  }

  if (pendingApproval) {
    return {
      tone: 'idle',
      title: 'Waiting for approval',
      detail:
        pendingApproval.command ??
        (pendingApproval.kind === 'commandExecution' ? 'Run command' : 'File change'),
    };
  }

  if (pendingUserInputRequest) {
    return { tone: 'idle', title: 'Waiting for input' };
  }

  if (activity.tone === 'error' && activity.title !== 'Turn failed') {
    return activity;
  }

  if (heldActivity && !isLoading && !isTurnLikelyRunning) {
    return heldActivity;
  }

  if (
    isLoading ||
    isTurnLikelyRunning ||
    (activity.tone === 'running' && selectedChatStatus !== 'complete')
  ) {
    // Reuse the detailed title only when the activity is itself a running one.
    // Otherwise a settled title like "Ready" gets shown next to a spinner.
    const runningTitle = (activity.tone === 'running' ? activity.title.trim() : '') || 'Working';
    return {
      tone: 'running',
      title: runningTitle,
      detail: activity.tone === 'running' ? activity.detail : undefined,
    };
  }

  if (!isLoading && !isTurnLikelyRunning && selectedChatStatus === 'complete') {
    return { tone: 'complete', title: 'Turn completed' };
  }

  if (activity.tone === 'error' && activity.title === 'Turn failed') {
    return { tone: 'error', title: 'Turn failed', detail: turnFailureDetail ?? undefined };
  }

  return activity;
}

/** The status the header actually shows, once a disconnected bridge is applied. */
export function resolveDisplayedActivity(inputs: ActivityIndicatorInputs): ActivityState {
  const visible = resolveVisibleActivity(inputs);
  if (inputs.isConnected || !isBridgeRecoveryActivity(visible)) {
    return visible;
  }

  if (!inputs.showBridgeRecoveryBanner) {
    return { tone: 'idle', title: 'Ready' };
  }

  return {
    tone: 'error',
    title: 'Bridge disconnected',
    detail: 'Start the bridge on your computer to continue.',
  };
}
