import type { Chat, RunEvent } from '../../api/types';
import type { TranscriptContinuationState } from '../../screens/controllers/transcriptContinuationController';
import { screenAtom } from './registry';

export const selectedChatAtom = screenAtom<Chat | null>(null);

export const transcriptContinuationStateAtom = screenAtom<TranscriptContinuationState>((): TranscriptContinuationState => ({
  loading: false,
  error: null,
  exhausted: true,
  unavailableCount: 0,
}));

export const selectedParentChatAtom = screenAtom<Chat | null>(null);

export const selectedChatIdAtom = screenAtom<string | null>(null);

export const openingChatIdAtom = screenAtom<string | null>(null);

export const activeCommandsAtom = screenAtom<RunEvent[]>(() => []);

export const loadingWorkspaceRootsAtom = screenAtom(false);

export const pendingAgentIdAtom = screenAtom<string | null>(null);

export const runWatchdogNowAtom = screenAtom(0);

export const chatModelPreferencesLoadedAtom = screenAtom(false);

export const chatPlanSnapshotsLoadedAtom = screenAtom(false);
