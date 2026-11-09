import type { LocalToolPermission } from './toolDefinition';
import type { LocalGuidanceState } from './workspaceGuidance';

export interface LocalToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LocalMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  reasoning?: string;
  toolCalls?: LocalToolCall[];
  /** Child history lives in the owning tool's app document, never in another conversation. */
  children?: LocalChild[];
  tool?: {
    callId: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
    startedAt: string;
    completedAt?: string;
  };
}

export interface LocalChild {
  id: string;
  agent: 'explore' | 'general';
  workspaceId: string;
  modelId: string;
  status: LocalThread['status'];
  updatedAt: string;
  lastError: string | null;
  messages: LocalMessage[];
}

export interface LocalThread {
  version: 1;
  id: string;
  title: string;
  workspaceId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  status: 'idle' | 'running' | 'complete' | 'interrupted' | 'failed';
  activeTurnId: string | null;
  lastSubmissionId: string | null;
  lastError: string | null;
  messages: LocalMessage[];
}

/** Independently subscribable parts of the on-device runtime. */
export type OnDeviceRuntimeSlice =
  'threads' | 'loop' | 'models' | 'downloads' | 'preferences' | 'workspaces' | 'issues' | 'network';

export const ON_DEVICE_RUNTIME_SLICES: readonly OnDeviceRuntimeSlice[] = [
  'threads',
  'loop',
  'models',
  'downloads',
  'preferences',
  'workspaces',
  'issues',
  'network',
];

/**
 * `persistence`: in-memory state could not be written; `retryPersistence()` rewrites it.
 * `operation`: a transient action failed; dismiss it after reading.
 * `recovery`: startup set damaged data aside (bytes preserved) and continued.
 */
export type OnDeviceIssueKind = 'persistence' | 'operation' | 'recovery';

export interface OnDeviceIssue {
  id: string;
  kind: OnDeviceIssueKind;
  message: string;
  /** The conversation this issue belongs to, or null when it is runtime-wide. */
  threadId: string | null;
  retryable: boolean;
}

export type OnDeviceReachability = 'unknown' | 'online' | 'offline';

/** A model tool call waiting for an explicit user decision before it may run. */
export interface LocalToolApproval extends LocalToolPermission {
  threadId: string;
  turnId: string;
  callId: string;
  toolName: string;
}

export interface LocalRunSnapshot {
  phase: 'idle' | 'preparing' | 'generating' | 'tool' | 'approval' | 'stopping' | 'persisting';
  threadId: string | null;
  turnId: string | null;
  toolName: string | null;
  approval: LocalToolApproval | null;
}

export const IDLE_LOCAL_RUN: LocalRunSnapshot = {
  phase: 'idle',
  threadId: null,
  turnId: null,
  toolName: null,
  approval: null,
};

export type LocalToolExecutor = (
  workspaceId: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export type LocalToolApprovalPolicy = (name: string, args?: unknown) => LocalToolPermission | null;

/** In-process turn ownership; this state is never serialized into thread documents. */
export interface LocalAgentRun {
  threadId: string;
  workspaceId: string;
  modelId: string;
  turnId: string;
  submissionId: string | null;
  stopped: boolean;
  promise: Promise<LocalThread> | null;
  interrupt: Promise<never>;
  signalStop: () => void;
  controller: AbortController;
  approval: { callId: string; resolve: (approved: boolean | 'policy') => void } | null;
  guidance: LocalGuidanceState;
  childAdmissions: number;
}
