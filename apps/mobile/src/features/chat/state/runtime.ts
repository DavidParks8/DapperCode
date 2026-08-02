import type {
  BridgeQueuedMessage,
  BridgeThreadQueueError,
  BridgeUiSurface,
  PendingApproval,
  PendingUserInputRequest,
  RunEvent,
  TurnPlanStep,
} from '@bridge/types/types';
import { screenAtom } from './registry';

export type ActivityTone = 'running' | 'complete' | 'error' | 'idle';

export interface ActivityState {
  tone: ActivityTone;
  title: string;
  detail?: string;
}

export interface ActivePlanState {
  threadId: string;
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
  deltaText: string;
  updatedAt: string;
}

export interface ThreadContextUsage {
  totalTokens: number | null;
  lastTokens: number | null;
  modelContextWindow: number | null;
  updatedAtMs: number;
}

export interface ThreadRuntimeSnapshot {
  activity?: ActivityState;
  activeCommands?: RunEvent[];
  latestCommand?: RunEvent | null;
  streamingText?: string | null;
  pendingApproval?: PendingApproval | null;
  pendingUserInputRequest?: PendingUserInputRequest | null;
  bridgeUiSurfaces?: BridgeUiSurface[];
  queuedMessages?: BridgeQueuedMessage[];
  pendingSteerMessageIds?: string[];
  waitingForToolCalls?: boolean;
  steeringInFlight?: boolean;
  queuedMessageError?: BridgeThreadQueueError | null;
  contextUsage?: ThreadContextUsage | null;
  plan?: ActivePlanState | null;
  activeTurnId?: string | null;
  runWatchdogUntil?: number;
  updatedAtMs: number;
}

export const threadRuntimeSnapshotsAtom = screenAtom<Record<string, ThreadRuntimeSnapshot>>(
  () => ({}),
);
