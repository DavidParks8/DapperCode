import type { Chat } from '@bridge/types/types';
import { type ActivityState, isBridgeRecoveryActivity } from '../helpers/helpers';

export interface ActivityIndicatorInputs {
  activity: ActivityState;
  heldActivity: ActivityState | null;
  isConnected: boolean;
  isLoading: boolean;
  isOpeningChat: boolean;
  isTurnLikelyRunning: boolean;
  pendingApproval: { command?: string | null; kind?: string | null } | null;
  pendingUserInputRequest: unknown;
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
function resolveOpeningChatActivity({
  isOpeningChat,
}: Pick<ActivityIndicatorInputs, 'isOpeningChat'>): ActivityState | null {
  return isOpeningChat ? { tone: 'running', title: 'Opening chat' } : null;
}

function resolvePendingApprovalActivity(
  pendingApproval: ActivityIndicatorInputs['pendingApproval'],
): ActivityState | null {
  if (!pendingApproval) {
    return null;
  }

  return {
    tone: 'idle',
    title: 'Waiting for approval',
    detail:
      pendingApproval.command ??
      (pendingApproval.kind === 'commandExecution' ? 'Run command' : 'File change'),
  };
}

function resolvePendingUserInputActivity(
  pendingUserInputRequest: ActivityIndicatorInputs['pendingUserInputRequest'],
): ActivityState | null {
  return pendingUserInputRequest ? { tone: 'idle', title: 'Waiting for input' } : null;
}

function resolveBlockingErrorActivity(activity: ActivityState): ActivityState | null {
  return activity.tone === 'error' && activity.title !== 'Turn failed' ? activity : null;
}

function resolveHeldVisibleActivity(
  heldActivity: ActivityIndicatorInputs['heldActivity'],
  isLoading: boolean,
  isTurnLikelyRunning: boolean,
): ActivityState | null {
  return heldActivity && !isLoading && !isTurnLikelyRunning ? heldActivity : null;
}

function resolveRunningActivity(inputs: ActivityIndicatorInputs): ActivityState | null {
  const { activity, isLoading, isTurnLikelyRunning, selectedChatStatus } = inputs;
  const shouldShowRunning =
    isLoading ||
    isTurnLikelyRunning ||
    (activity.tone === 'running' && selectedChatStatus !== 'complete');
  if (!shouldShowRunning) {
    return null;
  }

  const runningTitle = (activity.tone === 'running' ? activity.title.trim() : '') || 'Working';
  return {
    tone: 'running',
    title: runningTitle,
    detail: activity.tone === 'running' ? activity.detail : undefined,
  };
}

function resolveCompletedActivity(
  isLoading: boolean,
  isTurnLikelyRunning: boolean,
  selectedChatStatus: ActivityIndicatorInputs['selectedChatStatus'],
): ActivityState | null {
  return !isLoading && !isTurnLikelyRunning && selectedChatStatus === 'complete'
    ? { tone: 'complete', title: 'Turn completed' }
    : null;
}

function resolveTurnFailureActivity(
  activity: ActivityState,
  turnFailureDetail: string | null,
): ActivityState | null {
  return activity.tone === 'error' && activity.title === 'Turn failed'
    ? { tone: 'error', title: 'Turn failed', detail: turnFailureDetail ?? undefined }
    : null;
}

export function resolveVisibleActivity(inputs: ActivityIndicatorInputs): ActivityState {
  return (
    resolveOpeningChatActivity(inputs) ??
    resolvePendingApprovalActivity(inputs.pendingApproval) ??
    resolvePendingUserInputActivity(inputs.pendingUserInputRequest) ??
    resolveBlockingErrorActivity(inputs.activity) ??
    resolveHeldVisibleActivity(inputs.heldActivity, inputs.isLoading, inputs.isTurnLikelyRunning) ??
    resolveRunningActivity(inputs) ??
    resolveCompletedActivity(
      inputs.isLoading,
      inputs.isTurnLikelyRunning,
      inputs.selectedChatStatus,
    ) ??
    resolveTurnFailureActivity(inputs.activity, inputs.turnFailureDetail) ??
    inputs.activity
  );
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

const SETTLED_IDLE_TITLES = new Set(['ready']);

/**
 * Whether the status is a settled "nothing is happening" state that is not worth a
 * line above the composer. An enabled composer already says the agent is ready, so
 * rendering "Ready" only leaves permanent chrome on screen. Idle states that are
 * genuinely waiting on the user, such as an approval or an input request, are not
 * settled and still report themselves.
 */
export function isSettledIdleActivity(activity: ActivityState): boolean {
  if (activity.tone !== 'idle' || (activity.detail?.trim().length ?? 0) > 0) {
    return false;
  }

  const title = activity.title.trim().toLowerCase();
  return title.length === 0 || SETTLED_IDLE_TITLES.has(title);
}
