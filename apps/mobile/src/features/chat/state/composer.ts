import type { PrimitiveAtom, SetStateAction } from 'jotai';

import type { ActivityState, PendingPlanImplementationPrompt } from '../helpers/helpers';
import { derivedScreenAtom, screenAtom } from './registry';

export const keyboardVisibleAtom = screenAtom(false);

export const keyboardInsetAtom = screenAtom(0);

export const composerHeightAtom = screenAtom(0);

export const topChromeHeightAtom = screenAtom(0);

export const queueActionItemIdAtom = screenAtom<string | null>(null);

export const queueActionKindAtom = screenAtom<
  'steer' | 'cancel' | 'editStart' | 'editCommit' | 'editCancel' | null
>(null);

const storedActivityAtom = screenAtom<ActivityState>((): ActivityState => ({
  tone: 'idle',
  title: 'Ready',
}));

/**
 * A phase the agent reported for the current run (`announce`, for example "Generating") outlives
 * the shell's own generic "Working", which send, accept, and run-start paths write as a default.
 */
export function keepReportedRunActivity(
  previous: ActivityState,
  next: ActivityState,
): ActivityState {
  const genericNext =
    next.tone === 'running' && !next.announce && !next.detail && next.title === 'Working';
  return genericNext && previous.tone === 'running' && previous.announce ? previous : next;
}

export const activityAtom: PrimitiveAtom<ActivityState> = derivedScreenAtom(
  (get) => get(storedActivityAtom),
  (get, set, update: SetStateAction<ActivityState>) => {
    const previous = get(storedActivityAtom);
    const next = typeof update === 'function' ? update(previous) : update;
    set(storedActivityAtom, keepReportedRunActivity(previous, next));
  },
);

export const bridgeRecoveryBannerVisibleAtom = screenAtom(false);

export const heldActivityAtom = screenAtom<ActivityState | null>(null);

export const showDelayedGenericRunningActivityAtom = screenAtom(false);

export const planPanelCollapsedByThreadAtom = screenAtom<Record<string, boolean>>(
  (): Record<string, boolean> => ({}),
);

export const pendingPlanImplementationPromptsAtom = screenAtom(
  (): Record<string, PendingPlanImplementationPrompt> => ({}),
);
