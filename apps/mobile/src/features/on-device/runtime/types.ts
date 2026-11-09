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
  tool?: {
    callId: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
    startedAt: string;
    completedAt?: string;
  };
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
  /** Durable conversation state, never reconstructed from compacted model history. */
  tasks?: LocalTask[];
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
import type { LocalTask } from './interactionTools';
import type { PendingUserInputRequest } from '@bridge/types/types';
import type { LocalToolPermission } from './toolDefinition';

/** A model tool call waiting for an explicit user decision before it may run. */
export interface LocalToolApproval extends LocalToolPermission {
  threadId: string;
  turnId: string;
  callId: string;
  toolName: string;
}

export interface LocalRunSnapshot {
  phase:
    'idle' | 'preparing' | 'generating' | 'tool' | 'approval' | 'input' | 'stopping' | 'persisting';
  threadId: string | null;
  turnId: string | null;
  toolName: string | null;
  approval: LocalToolApproval | null;
  userInput?: PendingUserInputRequest | null;
}

export const LOCAL_IDLE_RUN: LocalRunSnapshot = {
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
/** Reads the permission request declared by a registered tool, otherwise null. */
export type LocalToolApprovalPolicy = (name: string, args?: unknown) => LocalToolPermission | null;
