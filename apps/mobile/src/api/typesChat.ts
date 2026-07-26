import type { Message } from '@ag-ui/core';
import type { RawAcpSnapshot } from './chatMapping';
import type { TurnPlanStep } from './typesBridge';

export type ChatStatus = 'idle' | 'running' | 'error' | 'complete';
export type AgentId = string;

export interface AgentDefaultSettings {
  collaborationMode?: CollaborationMode;
}

export type AgentDefaultSettingsMap = Record<AgentId, AgentDefaultSettings>;

export type ChatMessageRole = Message['role'];

export interface ChatMessageSubAgentMeta {
  toolCallId?: string;
  tool?: string;
  prompt?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  agentStatus?: string;
  navigable?: boolean;
}

export type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; mimeType?: string; uri?: string; url?: string }
  | { type: 'audio'; data?: string; mimeType?: string; uri?: string }
  | {
      type: 'resourceLink';
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    }
  | {
      type: 'resource';
      resource: {
        uri?: string;
        text?: string;
        blob?: string;
        mimeType?: string;
        [key: string]: unknown;
      };
    };

export type ChatToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ChatToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * The ACP facts a tool row needs that an AG-UI message cannot carry: the kind
 * picks the icon and the body renderer, the status drives the progress and
 * failure affordances, and the structured content keeps diffs and terminals
 * renderable instead of pre-flattened text.
 */
export interface ChatToolMeta {
  toolCallId: string;
  kind: ChatToolKind;
  status: ChatToolStatus;
  title: string;
  content?: unknown[];
  locations?: unknown[];
  truncated?: boolean;
}

interface ChatMessageMetadata {
  parts?: ChatMessagePart[];
  createdAt: string;
  pending?: boolean;
  toolMeta?: ChatToolMeta;
}

export type ChatMessage = Message & ChatMessageMetadata;

export interface ChatSummary {
  id: string;
  title: string;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  /** True when the bridge reported no timestamps and they were derived locally. */
  timestampsSynthesized?: boolean;
  lastMessagePreview: string;
  cwd?: string;
  agentId?: AgentId | null;
  modelProvider?: string;
  agentNickname?: string;
  agentRole?: string;
  sourceKind?: string;
  parentThreadId?: string;
  subAgentDepth?: number;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  lastRunDurationMs?: number;
  lastRunExitCode?: number | null;
  lastRunTimedOut?: boolean;
  lastError?: string;
}

export interface ChatPlanSnapshot {
  threadId: string;
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
}

export interface Chat extends ChatSummary {
  messages: ChatMessage[];
  acpSnapshot?: RawAcpSnapshot;
  latestPlan?: ChatPlanSnapshot | null;
  latestTurnPlan?: ChatPlanSnapshot | null;
  latestTurnStatus?: string | null;
  activeTurnId?: string | null;
  acpUsage?: { used: number | null; size: number | null; cost: string | null } | null;
  acpMode?: string | null;
  acpConfig?: AcpConfigOption[];
  acpCommands?: Array<{ name: string; description: string }>;
  acpActive?: {
    runId: string | null;
    sourceTurnId: string | null;
    generation: number | null;
    toolIds: string[];
  } | null;
}

export interface CreateChatRequest {
  title?: string;
  message?: string;
  cwd?: string;
  agentId?: AgentId;
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  approvalPolicy?: ApprovalPolicy;
  collaborationMode?: CollaborationMode;
  agentMode?: string | null;
}

export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  value: string;
  name?: string;
  description?: string;
  category?: string;
  options?: AcpConfigOptionValue[];
}

export type CollaborationMode = 'default' | 'plan';

export interface SendChatMessageRequest {
  content: string;
  role?: ChatMessageRole;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  approvalPolicy?: ApprovalPolicy;
  collaborationMode?: CollaborationMode;
  agent?: string | null;
  mentions?: MentionInput[];
  localImages?: LocalImageInput[];
}

export interface SteerChatTurnRequest {
  content: string;
  mentions?: MentionInput[];
  localImages?: LocalImageInput[];
}

export interface MentionInput {
  path: string;
  name?: string;
}

export interface LocalImageInput {
  path: string;
}

export interface BridgeQueuedMessage {
  id: string;
  createdAt: string;
  content: string;
}

export interface BridgeThreadQueueError {
  message: string;
  operation: string;
  at: string;
  itemId?: string | null;
}

export interface BridgeThreadQueueState {
  threadId: string;
  items: BridgeQueuedMessage[];
  pendingSteers: BridgeQueuedMessage[];
  pendingSteerCount: number;
  waitingForToolCalls: boolean;
  steeringInFlight: boolean;
  lastError?: BridgeThreadQueueError | null;
}

export type BridgeThreadQueueDisposition = 'queued' | 'sent';

export interface BridgeThreadQueueSendResponse {
  submissionId: string;
  disposition: BridgeThreadQueueDisposition;
  queue: BridgeThreadQueueState;
  turnId?: string | null;
}

export interface BridgeThreadCreateResponse {
  submissionId: string;
  thread: unknown;
}

export interface BridgeThreadQueueActionResponse {
  ok: boolean;
  queue: BridgeThreadQueueState;
}

export type AttachmentUploadKind = 'file' | 'image';

export interface UploadAttachmentRequest {
  uri: string;
  fileName?: string;
  mimeType?: string;
  threadId?: string;
  kind: AttachmentUploadKind;
}

export interface UploadAttachmentResponse {
  path: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  kind: AttachmentUploadKind;
}

export interface WorkspaceSummary {
  path: string;
  chatCount: number;
  updatedAt?: string;
}

export interface WorkspaceListResponse {
  bridgeRoot: string;
  allowOutsideRootCwd: boolean;
  workspaces: WorkspaceSummary[];
}

export interface FileSystemListRequest {
  path?: string | null;
  includeHidden?: boolean;
  directoriesOnly?: boolean;
  includeGitRepo?: boolean;
}

export interface FileSystemEntry {
  name: string;
  path: string;
  kind: string;
  hidden: boolean;
  selectable: boolean;
  isGitRepo: boolean;
}

export interface FileSystemListResponse {
  bridgeRoot: string;
  path: string;
  parentPath: string | null;
  entries: FileSystemEntry[];
  truncated: boolean;
  totalEntries: number;
  omittedEntries: number;
  maxEntries: number;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ServiceTier = 'flex' | 'fast';

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'on-failure' | 'never';

export type ApprovalMode = 'normal' | 'yolo';

export interface ModelReasoningEffortOption {
  effort: ReasoningEffort;
  description?: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
  providerId?: string;
  providerName?: string;
  contextWindow?: number;
  connected?: boolean;
  authRequired?: boolean;
  hidden?: boolean;
  supportsPersonality?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEffort?: ModelReasoningEffortOption[];
}
