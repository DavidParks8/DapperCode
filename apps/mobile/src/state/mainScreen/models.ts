import type {
  AgentId,
  CollaborationMode,
  ModelOption,
  ReasoningEffort,
  ServiceTier,
} from '../../api/types';
import type { SelectedServiceTier } from '../../screens/main/mainScreenHelpers';
export { bridgeCapabilitiesAtom } from '../bridge/capabilities';
import { screenAtom } from './registry';

export const modelOptionsByAgentAtom = screenAtom<Record<AgentId, ModelOption[]>>(
  (): Record<AgentId, ModelOption[]> => ({}),
);

export const loadingModelsAtom = screenAtom(false);

export const selectedModelIdAtom = screenAtom<string | null>(null);

export const selectedEffortAtom = screenAtom<ReasoningEffort | null>(null);

export const selectedServiceTierAtom = screenAtom<SelectedServiceTier>(undefined);

export const defaultServiceTierAtom = screenAtom<ServiceTier | null>(null);

export const selectedCollaborationModeAtom = screenAtom<CollaborationMode>('default');

export const selectedAcpModeIdAtom = screenAtom<string | null>(null);
