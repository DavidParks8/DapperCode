import type { RawAcpSnapshot, RawThread } from '@bridge/mapping/chatMapping';
import type { ChatToolKind, ChatToolStatus } from '@bridge/types/types';
import type { RunActivity } from '@bridge/runActivity';
import { findLocalModelDefinition, localModelDefinition, localModelName } from '../models/catalog';
import type { LocalModelSessionSnapshot } from '../models/session';
import type { LocalModelDefinition } from '../models/types';
import type { LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalChild, LocalMessage, LocalThread, LocalToolCall } from '../runtime/types';
import type { LocalWorkspace } from '../workspaces/types';

/** Agent identity the local transport reports for every local chat. */
export const LOCAL_AGENT_ID = 'on-device';
export const LOCAL_AGENT_NAME = 'On this iPhone';
/** Virtual root that local workspaces are presented under, so they look like bridge paths. */
export const LOCAL_WORKSPACE_ROOT = '/On this iPhone';
/** ACP config id used to expose and change a local chat's model through the model sheet. */
export const LOCAL_MODEL_CONFIG_ID = 'model';
/** Shown wherever a chat's workspace was removed from this iPhone. */
export const LOCAL_UNAVAILABLE_WORKSPACE = 'Workspace unavailable';
/** The `Latest:` line of a sub-agent card is bounded like the bridge bounds ACP sub-agents. */
const CHILD_LATEST_CHARS = 512;

/** The path segment a workspace name is presented as. */
export function localWorkspaceDisplayName(name: string): string {
  return name.replace(/\//g, '-').trim() || 'Workspace';
}

/** Case-insensitive identity of a workspace name; two workspaces never share one. */
export function localWorkspaceNameKey(name: string): string {
  return localWorkspaceDisplayName(name).toLowerCase();
}

function workspaceTag(id: string): string {
  return id.slice(0, 6).toLowerCase();
}

/** A trailing ` (<tag>)`, which ties a presented path to its workspace id. */
const WORKSPACE_TAG = / \(([^()/]{1,6})\)$/u;
/** Names that could be read as a tagged path of a native (UUID) workspace. */
const TAG_LIKE_NAME = / \([0-9a-f]{6}\)$/iu;

/**
 * Workspace id → presented path. A path depends only on the workspace's own name and id, never on
 * its siblings' order: a name that more than one workspace shares (or that could be mistaken for
 * a tagged path or the unavailable placeholder) is presented with its id tag, ` (<id6>)`, for
 * every member, so creating, renaming, or deleting another workspace cannot hand its path over.
 */
export function localWorkspacePaths(workspaces: readonly LocalWorkspace[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const key = localWorkspaceNameKey(workspace.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const paths = new Map<string, string>();
  for (const workspace of workspaces) {
    const name = localWorkspaceDisplayName(workspace.name);
    const tagged =
      (counts.get(localWorkspaceNameKey(workspace.name)) ?? 0) > 1 ||
      name === LOCAL_UNAVAILABLE_WORKSPACE ||
      TAG_LIKE_NAME.test(name);
    paths.set(
      workspace.id,
      `${LOCAL_WORKSPACE_ROOT}/${tagged ? `${name} (${workspaceTag(workspace.id)})` : name}`,
    );
  }
  return paths;
}

/**
 * The workspace a presented path was issued for, or null when it cannot be told unambiguously.
 * A current path resolves exactly; a tagged path resolves by its id tag alone, so it survives its
 * workspace being renamed and other workspaces joining or leaving its name. A path is never
 * guessed onto a different workspace.
 */
export function localWorkspaceIdForPath(
  workspaces: readonly LocalWorkspace[],
  path: string | null | undefined,
): string | null {
  const normalized = path?.trim().replace(/\/+$/u, '');
  if (!normalized?.startsWith(`${LOCAL_WORKSPACE_ROOT}/`)) {
    return null;
  }
  const exact = [...localWorkspacePaths(workspaces)].filter(([, entry]) => entry === normalized);
  if (exact.length > 0) {
    return exact.length === 1 ? (exact[0]?.[0] ?? null) : null;
  }
  const tag = WORKSPACE_TAG.exec(normalized.slice(LOCAL_WORKSPACE_ROOT.length + 1))?.[1];
  const tagged = tag
    ? workspaces.filter((workspace) => workspaceTag(workspace.id) === tag.toLowerCase())
    : [];
  return tagged.length === 1 ? (tagged[0]?.id ?? null) : null;
}

export function localFallbackWorkspaceId(
  workspaces: readonly LocalWorkspace[],
  preferred: string | null | undefined,
  recent: string | null | undefined,
): string | null {
  const exists = (id: string | null | undefined) =>
    id && workspaces.some((workspace) => workspace.id === id) ? id : null;
  return (
    exists(preferred) ??
    exists(recent) ??
    (workspaces.length === 1 ? (workspaces[0]?.id ?? null) : null)
  );
}

export function localRunId(threadId: string, turnId: string): string {
  return `${threadId}::turn::${turnId}`;
}

export function localReasoningId(messageId: string): string {
  return `${messageId}::reasoning`;
}

const TOOL_VERBS: Record<
  string,
  { kind: ChatToolKind; verb: string; activity: string; pathKey?: string }
> = {
  list_directory: { kind: 'read', verb: 'List', activity: 'Listing', pathKey: 'path' },
  read_file: { kind: 'read', verb: 'Read', activity: 'Reading', pathKey: 'path' },
  write_file: { kind: 'edit', verb: 'Write', activity: 'Writing', pathKey: 'path' },
  edit_file: { kind: 'edit', verb: 'Edit', activity: 'Editing', pathKey: 'path' },
  rename_path: { kind: 'move', verb: 'Rename', activity: 'Renaming', pathKey: 'path' },
  delete_path: { kind: 'delete', verb: 'Delete', activity: 'Deleting', pathKey: 'path' },
  search_files: { kind: 'search', verb: 'Search', activity: 'Searching', pathKey: 'query' },
  read_tool_output: { kind: 'read', verb: 'Read saved output', activity: 'Reading saved output' },
  search_tool_output: {
    kind: 'search',
    verb: 'Search saved output',
    activity: 'Searching saved output',
    pathKey: 'query',
  },
  git_status: { kind: 'read', verb: 'Git status', activity: 'Checking Git status' },
  git_diff: { kind: 'read', verb: 'Git diff', activity: 'Reading the Git diff' },
  git_history: { kind: 'read', verb: 'Git history', activity: 'Reading Git history' },
  git_stage: { kind: 'other', verb: 'Git stage', activity: 'Staging', pathKey: 'path' },
  git_commit: { kind: 'other', verb: 'Git commit', activity: 'Committing' },
  git_push: { kind: 'other', verb: 'Git push', activity: 'Pushing' },
  web_fetch: { kind: 'fetch', verb: 'Fetch', activity: 'Fetching', pathKey: 'url' },
  web_search: { kind: 'search', verb: 'Search web', activity: 'Searching web', pathKey: 'query' },
  ask_user: { kind: 'think', verb: 'Ask user', activity: 'Waiting for answers' },
  todo_read: { kind: 'think', verb: 'Todo read', activity: 'Reading tasks' },
  todo_write: { kind: 'think', verb: 'Todo write', activity: 'Updating tasks' },
  skill: { kind: 'read', verb: 'Read skill', activity: 'Loading skill', pathKey: 'name' },
  // Not "task": the shared snapshot mapper would turn that title into an empty sub-agent card.
  task: { kind: 'other', verb: 'Run sub-agents', activity: 'Starting sub-agents' },
};

/**
 * Human title, in-progress activity, and kind for a local tool call. Wave-2 chat parity extends
 * this single function instead of special-casing local tools in the transcript.
 */
export function describeLocalTool(
  name: string,
  argumentsJson: string | null,
): { kind: ChatToolKind; title: string; activity: string } {
  const known = TOOL_VERBS[name];
  if (!known) {
    const readable = name.replace(/_/g, ' ').trim() || 'tool';
    return { kind: 'other', title: name, activity: `Running ${readable}` };
  }
  let subject = known.pathKey ? toolArgument(argumentsJson, known.pathKey) : null;
  if (name === 'list_directory' && (subject === null || subject === '.')) {
    subject = 'workspace root';
  } else if (name === 'skill' && subject === null) {
    subject = 'list';
  }
  const quoted = subject && known.pathKey === 'query' ? `“${subject}”` : subject;
  return {
    kind: known.kind,
    title: quoted ? `${known.verb} ${quoted}` : known.verb,
    activity: quoted ? `${known.activity} ${quoted}` : known.activity,
  };
}

function toolArgument(argumentsJson: string | null, key: string): string | null {
  if (!argumentsJson) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    const value =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[key] : null;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * A local tool status on the wire, as the Rust bridge sends it: an interrupted call keeps ACP's
 * `failed` status (installed clients map unknown statuses to `pending`) plus `interrupted: true`.
 */
export function localToolStatus(status: NonNullable<LocalMessage['tool']>['status']): {
  status: Exclude<ChatToolStatus, 'interrupted'>;
  interrupted?: true;
} {
  switch (status) {
    case 'running':
      return { status: 'in_progress' };
    case 'interrupted':
      return { status: 'failed', interrupted: true };
    default:
      return { status };
  }
}

/**
 * Whether a tool message is a transcript row of its own, live and in snapshots alike. A `task` call
 * is presented by the sub-agent cards of the children it started, as ACP presents a sub-agent
 * session; it gets a row only once it settles without starting any (refused, stopped before
 * admission, or only resuming earlier children), so its result or error stays visible.
 */
export function localToolHasRow(message: LocalMessage): boolean {
  const tool = message.tool;
  return tool?.name === 'task'
    ? !message.children?.length && tool.status !== 'running' && tool.status !== 'pending'
    : Boolean(tool);
}

/**
 * Each tool call of a thread by id (the first one wins, as a scan would find it). Build it once per
 * projection so describing every tool stays linear in the thread instead of tools × messages.
 */
export function localToolCalls(thread: Pick<LocalThread, 'messages'>): Map<string, LocalToolCall> {
  const calls = new Map<string, LocalToolCall>();
  for (const message of thread.messages) {
    for (const call of message.toolCalls ?? []) {
      if (!calls.has(call.id)) {
        calls.set(call.id, call);
      }
    }
  }
  return calls;
}

type LocalToolDescription = ReturnType<typeof describeLocalTool>;

/**
 * Descriptions per call object. Runtime threads replace messages instead of mutating them, so a
 * call keeps its arguments for life, and its (possibly whole-file) arguments are parsed once.
 */
const described = new WeakMap<LocalToolCall, { name: string; value: LocalToolDescription }>();

function describeLocalToolCall(
  name: string,
  call: LocalToolCall | undefined,
): LocalToolDescription {
  if (!call) {
    return describeLocalTool(name, null);
  }
  const cached = described.get(call);
  if (cached?.name === name) {
    return cached.value;
  }
  const value = describeLocalTool(name, call.function.arguments);
  described.set(call, { name, value });
  return value;
}

export function describeLocalToolMessage(
  thread: Pick<LocalThread, 'messages'>,
  message: LocalMessage,
  calls?: ReadonlyMap<string, LocalToolCall>,
): LocalToolDescription {
  const tool = message.tool;
  if (!tool) {
    return { kind: 'other', title: 'Tool', activity: 'Running a tool' };
  }
  return describeLocalToolCall(tool.name, (calls ?? localToolCalls(thread)).get(tool.callId));
}

/** A task child's state, named as ACP sub-agent cards and `<task state>` headers name it. */
export function localChildState(child: LocalChild): string {
  switch (child.status) {
    case 'complete':
      return 'completed';
    case 'interrupted':
      return 'cancelled';
    case 'idle':
      return 'pending';
    default:
      return child.status;
  }
}

/**
 * A child card's `Latest:` line: the child's newest tool while it works (its streamed reply would
 * change the card on every token), then its answer or error once it settles. Always one line.
 */
export function localChildLatest(child: LocalChild): string {
  let latest = '';
  if (child.status === 'running' || child.status === 'idle') {
    const tool = child.messages.filter((message) => message.tool).at(-1);
    latest = tool ? describeLocalToolMessage(child, tool).title : '';
  } else {
    const answer =
      child.messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '';
    latest = child.status === 'complete' ? answer : child.lastError || answer;
  }
  return latest.replace(/\s+/gu, ' ').trim().slice(0, CHILD_LATEST_CHARS);
}

/**
 * What a running local turn is doing, named the way the user would describe it: loading the model
 * (with progress), generating, or the running tool's action. Null when the thread is not the one
 * running.
 */
export function localRunActivity(
  thread: LocalThread,
  run: LocalRunSnapshot,
  model: Pick<LocalModelSessionSnapshot, 'phase' | 'modelId' | 'progress'>,
): RunActivity | null {
  // Before the model loads the thread is not running yet; the loop already names it.
  const loading = run.phase === 'preparing' || run.phase === 'stopping';
  if (run.threadId !== thread.id || (thread.status !== 'running' && !loading)) {
    return null;
  }
  switch (run.phase) {
    case 'preparing':
      return preparingActivity(model);
    case 'generating':
      return { title: 'Generating' };
    case 'compacting':
      return { title: 'Summarizing conversation' };
    case 'tool':
      return toolActivity(thread);
    case 'stopping':
      return { title: model.phase === 'loading' ? 'Cancelling model load' : 'Stopping' };
    case 'persisting':
      return { title: 'Saving' };
    default:
      // Idle has nothing to report; an approval request drives the shell's own waiting state.
      return null;
  }
}

function preparingActivity(
  model: Pick<LocalModelSessionSnapshot, 'phase' | 'modelId' | 'progress'>,
): RunActivity {
  if (model.phase === 'loading') {
    const name = findLocalModelDefinition(model.modelId ?? '')?.name ?? 'model';
    const percent = Math.max(0, Math.min(100, Math.floor(model.progress)));
    return { title: `Loading ${name}`, detail: `${String(percent)}%` };
  }
  return model.phase === 'stopping'
    ? { title: 'Releasing the previous model' }
    : { title: 'Preparing' };
}

/** The running tool's action; between a tool settling and the next phase, nothing changes. */
function toolActivity(thread: LocalThread): RunActivity | null {
  const running = [...thread.messages]
    .reverse()
    .find((message) => message.tool?.status === 'running' || message.tool?.status === 'pending');
  if (running?.children?.length) {
    const active = running.children.filter((child) => child.status === 'running').length;
    return {
      title: 'Delegating',
      detail: `${String(active)} of ${String(running.children.length)} children running`,
    };
  }
  return running ? { title: describeLocalToolMessage(thread, running).activity } : null;
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
  /** The active run, so a turn that is still loading its model can be found and stopped. */
  run?: Pick<LocalRunSnapshot, 'phase' | 'threadId' | 'turnId'>;
  /** Cached skill slash commands for a workspace; see `LocalAgentPort.commands`. */
  commands: (workspaceId: string, refresh?: boolean) => Readonly<RawAcpSnapshot['commands']>;
}

export function localThreadPath(
  thread: Pick<LocalThread, 'workspaceId'>,
  workspaces: readonly LocalWorkspace[],
  paths: ReadonlyMap<string, string> = localWorkspacePaths(workspaces),
): string {
  return paths.get(thread.workspaceId) ?? `${LOCAL_WORKSPACE_ROOT}/${LOCAL_UNAVAILABLE_WORKSPACE}`;
}

/** Summary row used by `thread/list` and summary reads. */
export function localThreadSummary(
  thread: LocalThread,
  context: LocalThreadProjectionContext,
): RawThread {
  const parentThreadId = thread.parentThreadId;
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
    // A task child is presented the way the bridge presents an adopted ACP sub-agent session.
    ...(parentThreadId
      ? {
          source: { subAgent: { thread_spawn: { parentThreadId, depth: 1 } } },
          agentNickname: thread.agent === 'general' ? 'General agent' : 'Explore agent',
          ...(thread.agent ? { agentRole: thread.agent } : {}),
        }
      : {}),
  };
}

function modelConfig(thread: LocalThread, models: readonly LocalModelDefinition[]) {
  const options = models.map((model) => ({
    value: model.id,
    name: localModelName(model),
  }));
  if (!options.some((option) => option.value === thread.modelId)) {
    let name = thread.modelId;
    try {
      name = localModelName(localModelDefinition(thread.modelId));
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

/**
 * A failed conversation lists its last turn as failed with the runtime's message, which is how the
 * bridge reports a failed turn: reopening the chat shows why it failed and offers a retry.
 */
function failedTurn(thread: LocalThread): Pick<RawThread, 'turns'> | Record<string, never> {
  if (thread.status !== 'failed') {
    return {};
  }
  return {
    turns: [
      {
        id: `submission-${thread.lastSubmissionId ?? thread.id}`,
        status: 'failed',
        error: { message: thread.lastError ?? 'The local turn failed.' },
        items: [],
      },
    ],
  };
}

/**
 * Only the live turn is listed: it lets `interruptLatestTurn` find the run and lets the client
 * confirm an accepted message. History itself comes from the ACP snapshot. A send or retry that is
 * still loading its model has recorded nothing yet, but it is listed too so Stop can cancel the load.
 */
function liveTurn(
  thread: LocalThread,
  run: LocalThreadProjectionContext['run'],
): Pick<RawThread, 'turns'> | null {
  if (thread.status === 'running' && thread.activeTurnId) {
    const lastUser = [...thread.messages].reverse().find((message) => message.role === 'user');
    return {
      turns: [
        {
          id: thread.activeTurnId,
          status: 'inProgress',
          items: lastUser
            ? [
                {
                  type: 'userMessage' as const,
                  id: lastUser.id,
                  content: [{ type: 'text', text: lastUser.content }],
                },
              ]
            : [],
        },
      ],
    };
  }
  // Only a run that has not started is listed this way: once it starts the thread is running, and
  // while it settles (`persisting`) the thread already carries its final status.
  const loading = run?.phase === 'preparing' || run?.phase === 'stopping';
  if (loading && run?.threadId === thread.id && run.turnId) {
    return { turns: [{ id: run.turnId, status: 'inProgress', items: [] }] };
  }
  return null;
}

function childSnapshotTool(parentId: string, child: LocalChild): RawAcpSnapshot['tools'][number] {
  const statuses = {
    idle: 'pending',
    running: 'running',
    complete: 'completed',
    failed: 'failed',
    interrupted: 'interrupted',
  } as const;
  const latest = localChildLatest(child);
  return {
    id: `child:${parentId}:${child.id}`,
    generation: null,
    kind: 'think',
    ...localToolStatus(statuses[child.status]),
    title: `${child.agent} child`,
    startedAtMs: Date.parse(child.messages[0]?.createdAt ?? child.updatedAt),
    completedAtMs:
      child.status === 'running' || child.status === 'idle' ? null : Date.parse(child.updatedAt),
    // ACP's `<task>` header links the card to the child's own thread; it goes last because the
    // newest header wins and the result is model text.
    content: [
      latest ? `<task_result>${latest}</task_result>` : null,
      `<task id="${child.id}" state="${localChildState(child)}">`,
    ]
      .filter(Boolean)
      .join('\n'),
    structuredContent: [],
    locations: [],
    truncated: false,
    subagent: true,
  };
}

function childSnapshotTools(parentId: string, message: LocalMessage): RawAcpSnapshot['tools'] {
  return (message.children ?? []).map((child) => childSnapshotTool(parentId, child));
}

/** Full ACP-style snapshot used by `thread/read` with history. */
const localSnapshotPlan = (tasks: LocalThread['tasks']): RawAcpSnapshot['plan'] =>
  (tasks ?? []).map((task) => ({
    content: task.content,
    priority: 'medium',
    status: task.status,
  }));

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
  const calls = localToolCalls(thread);
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
    if (localToolHasRow(message)) {
      const described = describeLocalToolMessage(thread, message, calls);
      timeline.push({ sequence: timeline.length, kind: 'tool', canonicalId: tool.callId });
      tools.push({
        id: tool.callId,
        generation: null,
        kind: described.kind,
        ...localToolStatus(tool.status),
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
    for (const projected of childSnapshotTools(thread.id, message)) {
      timeline.push({ sequence: timeline.length, kind: 'tool', canonicalId: projected.id });
      tools.push(projected);
    }
  }
  // The ACP snapshot's active run only exists once the turn has started.
  const turnId = thread.status === 'running' ? thread.activeTurnId : null;
  return {
    ...localThreadSummary(thread, context),
    ...(liveTurn(thread, context.run) ?? failedTurn(thread)),
    acpSnapshot: {
      version: 2,
      timeline,
      messages,
      tools,
      plan: localSnapshotPlan(thread.tasks),
      usage: { used: null, size: contextSize(thread.modelId), cost: null },
      tokenTotals: null,
      mode: null,
      config: [modelConfig(thread, context.models)],
      commands: [...context.commands(thread.workspaceId)],
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
        toolIds:
          turnId !== null
            ? tools
                .filter((tool) => tool.status === 'pending' || tool.status === 'in_progress')
                .map((tool) => tool.id)
            : [],
      },
    },
  };
}
