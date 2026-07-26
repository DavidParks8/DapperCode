import type { AgUiLiveAssistantMessages } from '../../api/agUi';
import type {
  BridgeUiSurface,
  PendingApproval,
  PendingUserInputRequest,
} from '../../api/types';
import type { ActivePlanState } from '../../screens/mainScreenHelpers';
import { screenAtom } from './registry';

export const sendingAtom = screenAtom(false);

export const creatingAtom = screenAtom(false);

export const errorAtom = screenAtom<string | null>(null);

export const pendingApprovalAtom = screenAtom<PendingApproval | null>(null);

export const pendingUserInputRequestAtom = screenAtom<PendingUserInputRequest | null>(null);

export const userInputDraftsAtom = screenAtom<Record<string, string>>({});

export const userInputErrorAtom = screenAtom<string | null>(null);

export const resolvingUserInputAtom = screenAtom(false);

export const activePlanAtom = screenAtom<ActivePlanState | null>(null);

export const activeBridgeUiSurfacesAtom = screenAtom<BridgeUiSurface[]>([]);

export const liveAssistantByThreadAtom = screenAtom<AgUiLiveAssistantMessages>({});

export const activeTurnIdAtom = screenAtom<string | null>(null);

export const stoppingTurnAtom = screenAtom(false);
