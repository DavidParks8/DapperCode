import type { AgentId } from '@bridge/types/chat';

export type BridgeUiPresentation = 'workflowCard' | 'modal' | 'banner';
export type BridgeUiActionStyle = 'primary' | 'secondary' | 'destructive';
export type BridgeUiTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface BridgeUiTextBlock {
  type: 'text';
  text: string;
}

export interface BridgeUiMarkdownBlock {
  type: 'markdown';
  markdown: string;
}

export interface BridgeUiChecklistItem {
  label: string;
  status?: 'pending' | 'inProgress' | 'completed';
  detail?: string;
}

export interface BridgeUiChecklistBlock {
  type: 'checklist';
  items: BridgeUiChecklistItem[];
}

export interface BridgeUiKeyValueItem {
  label: string;
  value: string;
}

export interface BridgeUiKeyValueBlock {
  type: 'keyValue';
  items: BridgeUiKeyValueItem[];
}

export interface BridgeUiCodeBlock {
  type: 'code';
  text: string;
  language?: string | null;
}

export interface BridgeUiProgressBlock {
  type: 'progress';
  label: string;
  value: number;
  max: number;
  detail?: string | null;
}

export type BridgeUiBlock =
  | BridgeUiTextBlock
  | BridgeUiMarkdownBlock
  | BridgeUiChecklistBlock
  | BridgeUiKeyValueBlock
  | BridgeUiCodeBlock
  | BridgeUiProgressBlock;

export interface BridgeUiAction {
  id: string;
  label: string;
  style?: BridgeUiActionStyle;
  dismissesSurface?: boolean;
}

export interface BridgeUiSurface {
  id: string;
  threadId: string;
  turnId?: string | null;
  kind?: string | null;
  presentation: BridgeUiPresentation;
  tone?: BridgeUiTone;
  title: string;
  subtitle?: string | null;
  bodyMarkdown?: string | null;
  blocks: BridgeUiBlock[];
  actions: BridgeUiAction[];
  dismissible?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ResolveBridgeUiSurfaceRequest {
  threadId: string;
  turnId?: string | null;
  actionId: string;
}

export interface ResolveBridgeUiSurfaceResponse {
  ok: true;
  id: string;
  threadId: string;
  actionId: string;
}

export interface DismissBridgeUiSurfaceResponse {
  ok: true;
  id: string;
  threadId?: string | null;
}

export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

export interface TurnPlanUpdate {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
}

export interface RunEvent {
  id: string;
  threadId: string;
  eventType: string;
  at: string;
  detail?: string;
}

export interface BridgeCapabilities {
  protocolVersion: number;
  streamId: string;
  preferredAgentId: AgentId;
  activeAgentId: AgentId | null;
  agents: AgentDescriptor[];
  supportsByAgent: Record<AgentId, BridgeCapabilitySupport>;
  agUiEvents: boolean;
  supports: BridgeCapabilitySupport;
}

export interface AgentDescriptor {
  agentId: AgentId;
  displayName: string;
  icon?: string | null;
  version: string;
  provenance: string;
  lifecycle: 'ready' | 'unavailable' | 'stopped';
  lastError?: string | null;
  capabilities?: {
    sessionList: boolean;
    sessionLoad: boolean;
    sessionResume: boolean;
    sessionSteer: boolean;
    sessionFork?: boolean;
    sessionDelete?: boolean;
  } | null;
}

export interface BridgeCapabilitySupport {
  reviewStart: boolean;
  goalSlash?: boolean;
  planMode?: boolean;
  agentList?: boolean;
  turnSteer: boolean;
  threadFork?: boolean;
  threadDelete?: boolean;
  commandOutputDelta: boolean;
  fastMode?: boolean;
  browserPreview: boolean;
  genericUiSurface: boolean;
}

export interface BrowserPreviewSession {
  sessionId: string;
  targetUrl: string;
  previewPort: number;
  previewBaseUrl?: string | null;
  bootstrapPath: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
}

export interface BrowserPreviewTargetSuggestion {
  targetUrl: string;
  port: number;
  label: string;
}

export interface BrowserPreviewDiscoveryResponse {
  scannedAt: string;
  suggestions: BrowserPreviewTargetSuggestion[];
}

export interface RpcNotification {
  method: string;
  params: Record<string, unknown> | null;
  protocolVersion?: number;
  streamId?: string;
  eventId?: number;
}

export type BridgeSnapshotRequiredReason =
  'streamChanged' | 'replayTruncated' | 'replayInconsistent' | 'recoveryOverflow';

export interface BridgeSnapshotRequiredParams {
  reason: BridgeSnapshotRequiredReason;
  previousStreamId: string | null;
  lastDeliveredEventId: number;
  resumeAfterEventId: number;
  earliestEventId: number | null;
  latestEventId: number | null;
}
