import type { Chat, RunEvent } from '../../api/types';
import type { TranscriptContinuationState } from '../../screens/main/controllers/transcriptContinuationController';
import { screenAtom } from './registry';

export const selectedChatAtom = screenAtom<Chat | null>(null);

export const transcriptContinuationStateAtom = screenAtom<TranscriptContinuationState>(
  (): TranscriptContinuationState => ({
    loading: false,
    error: null,
    exhausted: true,
    unavailableCount: 0,
  }),
);

export const selectedParentChatAtom = screenAtom<Chat | null>(null);

export const selectedChatIdAtom = screenAtom<string | null>(null);

export const openingChatIdAtom = screenAtom<string | null>(null);

export const activeCommandsAtom = screenAtom<RunEvent[]>(() => []);

export const loadingWorkspaceRootsAtom = screenAtom(false);

export const pendingAgentIdAtom = screenAtom<string | null>(null);

/**
 * "Now" for run-watchdog comparisons (`runWatchdogUntil > runWatchdogNow`). It must start at the
 * current time: seeding it to 0 would make every watchdog look active until the first tick.
 */
export const runWatchdogNowAtom = screenAtom(() => Date.now());

export const chatModelPreferencesLoadedAtom = screenAtom(false);

export const chatPlanSnapshotsLoadedAtom = screenAtom(false);
