import type {
  AgentId,
  CollaborationMode,
  ModelOption,
  ReasoningEffort,
  ServiceTier,
} from '@bridge/types/types';
import type { SelectedServiceTier } from '../helpers/helpers';
export { bridgeCapabilitiesAtom } from '@shell/state/bridge/capabilities';
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

export interface PendingAcpConfigValue {
  value: string;
  revision: number;
}

export type PendingAcpConfigByChat = Record<
  string,
  Record<string, PendingAcpConfigValue | undefined> | undefined
>;

export const pendingAcpConfigByChatAtom = screenAtom<PendingAcpConfigByChat>(
  (): PendingAcpConfigByChat => ({}),
);
