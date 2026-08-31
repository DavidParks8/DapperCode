/** A message as a test author describes it, before projection into the bridge's raw thread shape. */
export interface ScenarioMessage {
  readonly id?: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ScenarioChat {
  readonly id: string;
  readonly title: string;
  readonly updatedAt?: number;
  readonly messages?: readonly ScenarioMessage[];
}

export interface Scenario {
  readonly chats: readonly ScenarioChat[];
  readonly agentId: string;
  readonly agentDisplayName: string;
}

export interface ScenarioOverrides {
  readonly chats?: readonly ScenarioChat[];
  readonly agentId?: string;
  readonly agentDisplayName?: string;
}

export const FIXED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);

export const DEFAULT_WORKSPACE = '/workspace/dappercode';
export const E2E_AGENT_ID = 'local-primary';

export function scenarioThreadId(acpSessionId: string, agentId = E2E_AGENT_ID): string {
  return `v1.${Buffer.from(agentId).toString('base64url')}.${Buffer.from(acpSessionId).toString(
    'base64url',
  )}`;
}

export const E2E_THREADS = {
  layout: scenarioThreadId('thread-layout'),
  short: scenarioThreadId('thread-short'),
  longTitle: scenarioThreadId('thread-long-title'),
} as const;

/**
 * The default scenario is intentionally shaped for layout work: a mix of short and long titles, a
 * long wrapping assistant answer, and a chat with no messages, so specs can exercise text wrapping,
 * truncation, and empty states without each spec inventing its own data.
 */
export function createDefaultScenario(overrides: ScenarioOverrides = {}): Scenario {
  return {
    agentId: overrides.agentId ?? E2E_AGENT_ID,
    agentDisplayName: overrides.agentDisplayName ?? 'Local Primary',
    chats: overrides.chats ?? [
      {
        id: 'thread-layout',
        title: 'Layout regressions',
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
        updatedAt: FIXED_NOW_SECONDS - 3_600,
        messages: [{ id: 'msg-user-2', role: 'user', text: 'Approved' }],
      },
      {
        id: 'thread-long-title',
        title:
          'Investigate the drawer row truncation behaviour when a session title is far longer than the available rail width',
        updatedAt: FIXED_NOW_SECONDS - 7_200,
        messages: [],
      },
    ],
  };
}
