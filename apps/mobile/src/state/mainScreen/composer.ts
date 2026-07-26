import type { ActivityState, PendingPlanImplementationPrompt } from '../../screens/main/mainScreenHelpers';
import { screenAtom } from './registry';

export const keyboardVisibleAtom = screenAtom(false);

export const androidKeyboardInsetAtom = screenAtom(0);

export const composerHeightAtom = screenAtom(0);

export const queueActionItemIdAtom = screenAtom<string | null>(null);

export const queueActionKindAtom = screenAtom<'steer' | 'cancel' | null>(null);

export const activityAtom = screenAtom<ActivityState>((): ActivityState => ({ tone: 'idle', title: 'Ready' }));

export const bridgeRecoveryBannerVisibleAtom = screenAtom(false);

export const heldActivityAtom = screenAtom<ActivityState | null>(null);

export const showDelayedGenericRunningActivityAtom = screenAtom(false);

export const planPanelCollapsedByThreadAtom = screenAtom<Record<string, boolean>>((): Record<string, boolean> => ({}));

export const pendingPlanImplementationPromptsAtom = screenAtom(
  (): Record<string, PendingPlanImplementationPrompt> => ({})
);
