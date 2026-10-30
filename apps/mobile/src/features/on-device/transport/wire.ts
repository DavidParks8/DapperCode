import type { RawAcpSnapshot, RawThread } from '@bridge/mapping/chatMapping';
import type {
  AgentDescriptor,
  BridgeCapabilities,
  BridgeCapabilitySupport,
  ChatToolKind,
  ChatToolStatus,
} from '@bridge/types/types';
import { localModelDefinition } from '../models/catalog';
import type { LocalModelDefinition } from '../models/types';
import type { LocalMessage, LocalThread } from '../runtime/types';
import type { LocalWorkspace } from '../workspaces/types';

/** Agent identity the local transport reports for every local chat. */
export const LOCAL_AGENT_ID = 'on-device';
export const LOCAL_AGENT_NAME = 'On this iPhone';
/** Virtual root that local workspaces are presented under, so they look like bridge paths. */
export const LOCAL_WORKSPACE_ROOT = '/On this iPhone';
/** ACP config id used to expose and change a local chat's model through the model sheet. */
export const LOCAL_MODEL_CONFIG_ID = 'model';
export const LOCAL_STREAM_ID = 'on-device';
export const LOCAL_PROTOCOL_VERSION = 2;

/**
 * What the local agent supports. Everything false is hidden by the chat shell (steer/queue,
 * forking, plan mode, browser preview, review, bridge UI surfaces, fast mode).
 */
export const LOCAL_CAPABILITY_SUPPORT: BridgeCapabilitySupport = {
  reviewStart: false,
  goalSlash: false,
  planMode: false,
  agentList: false,
  turnSteer: false,
  threadFork: false,
  threadDelete: true,
  commandOutputDelta: false,
  fastMode: false,
  browserPreview: false,
  genericUiSurface: false,
};

export function localCapabilities(): BridgeCapabilities {
  const agent: AgentDescriptor = {
    agentId: LOCAL_AGENT_ID,
    displayName: LOCAL_AGENT_NAME,
    icon: null,
    version: '1',
    provenance: 'Built into DapperCode',
    lifecycle: 'ready',
    capabilities: {
      sessionList: true,
      sessionLoad: true,
      sessionResume: true,
      sessionSteer: false,
      sessionFork: false,
      sessionDelete: true,
    },
  };
  return {
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    streamId: LOCAL_STREAM_ID,
    preferredAgentId: LOCAL_AGENT_ID,
    activeAgentId: LOCAL_AGENT_ID,
    agents: [agent],
    supportsByAgent: { [LOCAL_AGENT_ID]: LOCAL_CAPABILITY_SUPPORT },
    agUiEvents: true,
    supports: LOCAL_CAPABILITY_SUPPORT,
  };
}

export function localModelDisplayName(model: LocalModelDefinition): string {
  return `${model.name} · ${model.quantization}`;
}

/** Workspace id → presented path. Duplicate names get a stable, id-derived suffix. */
export function localWorkspacePaths(workspaces: readonly LocalWorkspace[]): Map<string, string> {
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const workspace of [...workspaces].sort((a, b) => a.id.localeCompare(b.id))) {
    const name = workspace.name.replace(/\//g, '-').trim() || 'Workspace';
    let path = `${LOCAL_WORKSPACE_ROOT}/${name}`;
    if (used.has(path)) {
      path = `${path} (${workspace.id.slice(0, 6).toLowerCase()})`;
    }
    used.add(path);
    paths.set(workspace.id, path);
  }
  return paths;
}

export function localWorkspaceIdForPath(
  workspaces: readonly LocalWorkspace[],
  path: string | null | undefined,
): string | null {
  const normalized = path?.trim().replace(/\/+$/u, '');
  if (!normalized) {
    return null;
  }
  for (const [id, candidate] of localWorkspacePaths(workspaces)) {
    if (candidate === normalized) {
      return id;
    }
  }
  return null;
}

export function localRunId(threadId: string, turnId: string): string {
  return `${threadId}::turn::${turnId}`;
}

export function localReasoningId(messageId: string): string {
  return `${messageId}::reasoning`;
}

const TOOL_VERBS: Record<string, { kind: ChatToolKind; verb: string; pathKey?: string }> = {
  list_directory: { kind: 'read', verb: 'List', pathKey: 'path' },
  read_file: { kind: 'read', verb: 'Read', pathKey: 'path' },
  write_file: { kind: 'edit', verb: 'Write', pathKey: 'path' },
  edit_file: { kind: 'edit', verb: 'Edit', pathKey: 'path' },
  rename_path: { kind: 'move', verb: 'Rename', pathKey: 'path' },
  delete_path: { kind: 'delete', verb: 'Delete', pathKey: 'path' },
  search_files: { kind: 'search', verb: 'Search', pathKey: 'query' },
  git_status: { kind: 'read', verb: 'Git status' },
  git_diff: { kind: 'read', verb: 'Git diff' },
  git_history: { kind: 'read', verb: 'Git history' },
  git_stage: { kind: 'other', verb: 'Git stage', pathKey: 'path' },
  git_commit: { kind: 'other', verb: 'Git commit' },
  git_push: { kind: 'fetch', verb: 'Git push' },
};

/**
 * Human title and kind for a local tool call. Wave-2 chat parity extends this single function
 * instead of special-casing local tools in the transcript.
 */
export function describeLocalTool(
  name: string,
  argumentsJson: string | null,
): { kind: ChatToolKind; title: string } {
  const known = TOOL_VERBS[name];
  if (!known) {
    return { kind: 'other', title: name };
  }
  let subject: string | null = null;
  if (known.pathKey && argumentsJson) {
    try {
      const parsed: unknown = JSON.parse(argumentsJson);
      const value =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)[known.pathKey]
          : null;
      subject = typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      subject = null;
    }
  }
  if (name === 'list_directory' && subject === null) {
    subject = 'workspace root';
  }
  return { kind: known.kind, title: subject ? `${known.verb} ${subject}` : known.verb };
}

export function localToolStatus(
  status: NonNullable<LocalMessage['tool']>['status'],
): ChatToolStatus {
  switch (status) {
    case 'running':
      return 'in_progress';
    case 'interrupted':
      return 'failed';
    default:
      return status;
  }
}

function toolArguments(thread: LocalThread, callId: string): string | null {
  for (const message of thread.messages) {
    const call = message.toolCalls?.find((entry) => entry.id === callId);
    if (call) {
      return call.function.arguments;
    }
  }
  return null;
}

export function describeLocalToolMessage(
  thread: LocalThread,
  message: LocalMessage,
): { kind: ChatToolKind; title: string } {
  const tool = message.tool;
  if (!tool) {
    return { kind: 'other', title: 'Tool' };
  }
  const described = describeLocalTool(tool.name, toolArguments(thread, tool.callId));
  return tool.status === 'interrupted'
    ? { ...described, title: `${described.title} (interrupted, inspect changes)` }
    : described;
}

function seconds(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function wireStatus(thread: LocalThread): string {
  switch (thread.status) {
    case 'running':
      return 'running';
    case 'complete':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

function preview(thread: LocalThread): string {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message && message.role !== 'tool' && message.content.trim()) {
      return message.content.trim().slice(0, 180);
    }
  }
  return '';
}

export interface LocalThreadProjectionContext {
  workspaces: readonly LocalWorkspace[];
  models: readonly LocalModelDefinition[];
}

export function localThreadPath(
  thread: Pick<LocalThread, 'workspaceId'>,
  workspaces: readonly LocalWorkspace[],
): string {
  return (
    localWorkspacePaths(workspaces).get(thread.workspaceId) ??
    `${LOCAL_WORKSPACE_ROOT}/Unavailable workspace`
  );
}

/** Summary row used by `thread/list` and summary reads. */
export function localThreadSummary(
  thread: LocalThread,
  context: LocalThreadProjectionContext,
): RawThread {
  return {
    id: thread.id,
    agentId: LOCAL_AGENT_ID,
    name: thread.title,
    preview: preview(thread),
    modelProvider: LOCAL_AGENT_NAME,
    createdAt: seconds(thread.createdAt),
    updatedAt: seconds(thread.updatedAt),
    status: wireStatus(thread),
    cwd: localThreadPath(thread, context.workspaces),
  };
}

function modelConfig(thread: LocalThread, models: readonly LocalModelDefinition[]) {
  const options = models.map((model) => ({
    value: model.id,
    name: localModelDisplayName(model),
  }));
  if (!options.some((option) => option.value === thread.modelId)) {
    let name = thread.modelId;
    try {
      name = localModelDisplayName(localModelDefinition(thread.modelId));
    } catch {
      // A removed catalog entry keeps showing its raw id.
    }
    options.unshift({ value: thread.modelId, name });
  }
  return {
    id: LOCAL_MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    value: thread.modelId,
    options,
  };
}

function contextSize(modelId: string): number | null {
  try {
    return localModelDefinition(modelId).contextTokens;
  } catch {
    return null;
  }
}

/** Full ACP-style snapshot used by `thread/read` with history. */
export function localThreadSnapshot(
  thread: LocalThread,
  context: LocalThreadProjectionContext,
): RawThread {
  const timeline: NonNullable<RawAcpSnapshot['timeline']> = [];
  const messages: RawAcpSnapshot['messages'] = [];
  const tools: RawAcpSnapshot['tools'] = [];
  const pushMessage = (id: string, role: string, text: string) => {
    timeline.push({
      sequence: timeline.length,
      kind: role === 'thought' ? 'reasoning' : 'message',
      canonicalId: id,
    });
    messages.push({ id, role, parts: [{ type: 'text', text }], truncated: false, usage: null });
  };
  for (const message of thread.messages) {
    if (message.role === 'user') {
      pushMessage(message.id, 'user', message.content);
      continue;
    }
    if (message.role === 'assistant') {
      if (message.reasoning?.trim()) {
        pushMessage(localReasoningId(message.id), 'thought', message.reasoning);
      }
      if (message.content.trim()) {
        pushMessage(message.id, 'agent', message.content);
      }
      continue;
    }
    const tool = message.tool;
    if (!tool) {
      continue;
    }
    const described = describeLocalToolMessage(thread, message);
    timeline.push({ sequence: timeline.length, kind: 'tool', canonicalId: tool.callId });
    tools.push({
      id: tool.callId,
      generation: null,
      kind: described.kind,
      status: localToolStatus(tool.status),
      title: described.title,
      startedAtMs: Date.parse(tool.startedAt),
      completedAtMs: tool.completedAt ? Date.parse(tool.completedAt) : null,
      content: message.content,
      structuredContent: [],
      locations: [],
      truncated: false,
      subagent: false,
    });
  }
  const running = thread.status === 'running' && thread.activeTurnId !== null;
  const turnId = running ? thread.activeTurnId : null;
  return {
    ...localThreadSummary(thread, context),
    acpSnapshot: {
      version: 2,
      timeline,
      messages,
      tools,
      plan: [],
      usage: { used: null, size: contextSize(thread.modelId), cost: null },
      tokenTotals: null,
      mode: null,
      config: [modelConfig(thread, context.models)],
      commands: [],
      session: {
        agentId: LOCAL_AGENT_ID,
        threadId: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        historyReconstruction: false,
      },
      active: {
        runId: turnId ? localRunId(thread.id, turnId) : null,
        sourceTurnId: turnId,
        generation: null,
        toolIds: running
          ? tools
              .filter((tool) => tool.status === 'pending' || tool.status === 'in_progress')
              .map((tool) => tool.id)
          : [],
      },
    },
  };
}
