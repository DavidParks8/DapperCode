import { FIXED_NOW_MS, PROTOCOL_VERSION, STREAM_ID } from './protocol.ts';

/** A message as a test author describes it, before projection into the bridge's raw thread shape. */
export interface ScenarioMessage {
  readonly id?: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ScenarioChat {
  readonly id: string;
  readonly title: string;
  readonly preview?: string;
  readonly cwd?: string;
  /** Unix seconds. Defaults derive from the fixed clock so ordering is deterministic. */
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly status?: 'idle' | 'running' | 'error' | 'complete';
  readonly messages?: readonly ScenarioMessage[];
}

export interface ScenarioWorkspace {
  readonly path: string;
  readonly name: string;
}

export interface Scenario {
  readonly chats: readonly ScenarioChat[];
  readonly workspaces: readonly ScenarioWorkspace[];
  readonly agentId: string;
  readonly agentDisplayName: string;
}

export interface ScenarioOverrides {
  readonly chats?: readonly ScenarioChat[];
  readonly workspaces?: readonly ScenarioWorkspace[];
  readonly agentId?: string;
  readonly agentDisplayName?: string;
}

const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);

export const DEFAULT_WORKSPACE = '/workspace/dappercode';

/**
 * The default scenario is intentionally shaped for layout work: a mix of short and long titles, a
 * long wrapping assistant answer, and a chat with no messages, so specs can exercise text wrapping,
 * truncation, and empty states without each spec inventing its own data.
 */
export function createDefaultScenario(overrides: ScenarioOverrides = {}): Scenario {
  return {
    agentId: overrides.agentId ?? 'local-primary',
    agentDisplayName: overrides.agentDisplayName ?? 'Local Primary',
    workspaces: overrides.workspaces ?? [
      { path: DEFAULT_WORKSPACE, name: 'dappercode' },
      { path: '/workspace/sandbox', name: 'sandbox' },
    ],
    chats: overrides.chats ?? [
      {
        id: 'thread-layout',
        title: 'Layout regressions',
        preview: 'The composer overlaps the transcript',
        status: 'complete',
        updatedAt: FIXED_NOW_SECONDS,
        messages: [
          { id: 'msg-user-1', role: 'user', text: 'Why does the composer overlap the transcript?' },
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            text: 'The transcript uses a fixed bottom inset while the composer grows with its content, so once the input wraps onto a third line the composer expands upward into the last message. Giving the transcript a bottom padding derived from the measured composer height keeps the final message fully visible.',
          },
        ],
      },
      {
        id: 'thread-short',
        title: 'Ship it',
        preview: 'Approved',
        status: 'idle',
        updatedAt: FIXED_NOW_SECONDS - 3_600,
        messages: [{ id: 'msg-user-2', role: 'user', text: 'Approved' }],
      },
      {
        id: 'thread-long-title',
        title:
          'Investigate the drawer row truncation behaviour when a session title is far longer than the available rail width',
        preview:
          'A very long preview line that should be clamped by the row rather than pushing the row taller',
        status: 'idle',
        updatedAt: FIXED_NOW_SECONDS - 7_200,
        messages: [],
      },
    ],
  };
}

export interface RawThreadItem {
  type: string;
  id: string;
  content: Array<{ type: 'text'; text: string }>;
}

export interface RawThreadTurn {
  id: string;
  status: string;
  items: RawThreadItem[];
}

export interface RawThread {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  turns?: RawThreadTurn[];
}

/** Projects a scenario chat into the summary shape the drawer list consumes. */
export function toRawThreadSummary(chat: ScenarioChat, index: number): RawThread {
  const updatedAt = chat.updatedAt ?? FIXED_NOW_SECONDS - index * 60;
  return {
    id: chat.id,
    name: chat.title,
    preview: chat.preview ?? '',
    cwd: chat.cwd ?? DEFAULT_WORKSPACE,
    createdAt: chat.createdAt ?? updatedAt - 600,
    updatedAt,
    status: { type: chat.status ?? 'idle' },
  };
}

/** Projects a scenario chat into the full thread shape, including a renderable transcript. */
export function toRawThread(chat: ScenarioChat, index: number): RawThread {
  const summary = toRawThreadSummary(chat, index);
  const messages = chat.messages ?? [];
  if (messages.length === 0) {
    return { ...summary, turns: [] };
  }

  return {
    ...summary,
    turns: [
      {
        id: `${chat.id}::turn::seed`,
        status: 'completed',
        items: messages.map((message, messageIndex) => ({
          type: message.role === 'user' ? 'userMessage' : 'agentMessage',
          id: message.id ?? `${chat.id}-msg-${String(messageIndex)}`,
          content: [{ type: 'text' as const, text: message.text }],
        })),
      },
    ],
  };
}

export function buildCapabilities(scenario: Scenario): Record<string, unknown> {
  const supports = {
    turnSteer: true,
    threadFork: true,
    threadDelete: true,
    reviewStart: false,
    commandOutputDelta: false,
    browserPreview: false,
    genericUiSurface: false,
  };
  return {
    protocolVersion: PROTOCOL_VERSION,
    streamId: STREAM_ID,
    preferredAgentId: scenario.agentId,
    activeAgentId: scenario.agentId,
    agents: [
      {
        agentId: scenario.agentId,
        displayName: scenario.agentDisplayName,
        version: '1.0.0',
        provenance: 'harness',
        lifecycle: 'ready',
        capabilities: {
          sessionList: true,
          sessionLoad: true,
          sessionResume: true,
          sessionSteer: true,
          sessionFork: true,
          sessionDelete: true,
        },
      },
    ],
    agUiEvents: true,
    supports,
    supportsByAgent: { [scenario.agentId]: supports },
  };
}

export function buildWorkspaceList(scenario: Scenario): Record<string, unknown> {
  return {
    bridgeRoot: DEFAULT_WORKSPACE,
    allowOutsideRootCwd: false,
    workspaces: scenario.workspaces.map((workspace) => ({
      path: workspace.path,
      name: workspace.name,
      isGitRepository: true,
    })),
  };
}

export function emptyQueueState(threadId: string): Record<string, unknown> {
  return {
    threadId,
    items: [],
    pendingSteers: [],
    pendingSteerCount: 0,
    waitingForToolCalls: false,
    steeringInFlight: false,
    lastError: null,
  };
}
