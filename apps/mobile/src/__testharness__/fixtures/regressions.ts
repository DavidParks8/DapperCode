import { EventType, type AGUIEvent } from '@ag-ui/core';
import type { Chat } from '../../api/types';
import { sequence } from '../EventSequenceBuilder';
import type { EventSequenceEntry } from '../EventSequenceBuilder';

const SUBAGENT_ACTIVITY = 'tethercode.subagent';

function chat(id: string, messages: Chat['messages']): Chat {
  return {
    id,
    title: '',
    status: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    statusUpdatedAt: new Date(0).toISOString(),
    lastMessagePreview: '',
    messages,
  };
}

function subAgentCard(
  parentThreadId: string,
  runId: string,
  options: {
    toolCallId: string;
    childThreadId?: string;
    status: string;
    heading: string;
    latest?: string;
  },
): EventSequenceEntry {
  const lines = [options.heading, `  Status: ${options.status}`];
  if (options.latest) {
    lines.push(`  Latest: ${options.latest}`);
  }
  return {
    threadId: parentThreadId,
    runId,
    event: {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: `subagent:${options.toolCallId}`,
      activityType: SUBAGENT_ACTIVITY,
      content: {
        text: lines.join('\n'),
        subAgent: {
          toolCallId: options.toolCallId,
          tool: 'spawnAgent',
          senderThreadId: parentThreadId,
          receiverThreadIds: options.childThreadId ? [options.childThreadId] : [],
          agentStatus: options.status,
          navigable: Boolean(options.childThreadId),
        },
      },
    } as unknown as AGUIEvent,
  };
}

/**
 * An assistant message that streams in chunks and is then replaced by an
 * authoritative snapshot carrying the complete text.
 */
export function streamThenAuthoritativeSnapshot(
  threadId = 'thread',
  runId = 'run-1',
): EventSequenceEntry[] {
  const messageId = `${threadId}::msg-1`;
  const full = "This needs a wider search, so I'll delegate to a sub-agent.";
  return [
    ...sequence(threadId, runId)
      .runStarted()
      .textStart(messageId, 'assistant')
      .textContent('This needs a', messageId)
      .build(),
    {
      threadId,
      runId,
      event: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: messageId, role: 'assistant', content: full }],
      } as unknown as AGUIEvent,
    },
  ];
}

/**
 * A snapshot built from the first turn, followed by a second prompt that the
 * snapshot does not know about yet.
 */
export function promptAfterSnapshot(
  threadId = 'thread',
  runId = 'run-1',
): { events: EventSequenceEntry[]; chat: Chat } {
  const firstUser = `${threadId}::user-1`;
  const firstAgent = `${threadId}::msg-1`;
  const secondUser = `${threadId}::user-2`;

  const events: EventSequenceEntry[] = [
    {
      threadId,
      runId,
      event: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: firstUser, role: 'user', content: 'first prompt' },
          { id: firstAgent, role: 'assistant', content: 'first answer' },
        ],
      } as unknown as AGUIEvent,
    },
  ];

  return {
    events,
    chat: chat(threadId, [
      { id: firstUser, role: 'user', content: 'first prompt', createdAt: new Date(1).toISOString() },
      {
        id: firstAgent,
        role: 'assistant',
        content: 'first answer',
        createdAt: new Date(2).toISOString(),
      },
      {
        id: secondUser,
        role: 'user',
        content: 'second prompt',
        createdAt: new Date(3).toISOString(),
      },
    ]),
  };
}

/**
 * Three turns replayed as history, each with its own message ids — what the
 * bridge emits when an agent replays a conversation on `session/load`.
 */
export function multiTurnReplayedHistory(
  threadId = 'thread',
): { events: EventSequenceEntry[]; chat: Chat } {
  const messages: Chat['messages'] = [];
  const snapshot: Array<{ id: string; role: string; content: string }> = [];
  const turns = ['turn one', 'turn two', 'turn three'];

  turns.forEach((text, index) => {
    const serial = index + 1;
    const userId = `${threadId}:history-${String(serial * 2 - 1)}:User`;
    const agentId = `${threadId}:history-${String(serial * 2)}:Agent`;
    messages.push({
      id: userId,
      role: 'user',
      content: text,
      createdAt: new Date(serial * 2).toISOString(),
    });
    messages.push({
      id: agentId,
      role: 'assistant',
      content: `answer ${String(serial)}`,
      createdAt: new Date(serial * 2 + 1).toISOString(),
    });
    snapshot.push({ id: userId, role: 'user', content: text });
    snapshot.push({ id: agentId, role: 'assistant', content: `answer ${String(serial)}` });
  });

  return {
    events: [
      {
        threadId,
        runId: `${threadId}::history`,
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: snapshot,
        } as unknown as AGUIEvent,
      },
    ],
    chat: chat(threadId, messages),
  };
}

/**
 * A sub-agent reported only through the parent's task tool — no child session is
 * ever streamed, which is how most ACP agents behave.
 */
export function parentOnlySubAgent(
  parentThreadId = 'parent',
  progress: string[] = ['Working'],
): { start: EventSequenceEntry[]; progress: EventSequenceEntry[]; finish: EventSequenceEntry[] } {
  const runId = `${parentThreadId}::run-1`;
  const toolCallId = `${parentThreadId}::task-1`;
  const [first, ...rest] = progress;

  return {
    start: [
      ...sequence(parentThreadId, runId)
        .runStarted()
        .textMessage("I'll delegate this.", { messageId: `${parentThreadId}::msg-1` })
        .build(),
      subAgentCard(parentThreadId, runId, {
        toolCallId,
        status: 'running',
        heading: '• Sub-agent working',
        latest: first,
      }),
    ],
    progress: rest.map((latest) =>
      subAgentCard(parentThreadId, runId, {
        toolCallId,
        status: 'running',
        heading: '• Sub-agent working',
        latest,
      }),
    ),
    finish: [
      subAgentCard(parentThreadId, runId, {
        toolCallId,
        status: 'completed',
        heading: '• Sub-agent completed',
        latest: 'No TODOs left in the repository.',
      }),
    ],
  };
}

/** A linked sub-agent run: a started run followed by the given card states. */
function linkedSubAgentSequence(
  parentThreadId: string,
  childThreadId: string,
  cards: Array<{ status: 'running' | 'completed'; heading: string; latest: string }>,
): EventSequenceEntry[] {
  const runId = `${parentThreadId}::run-1`;
  const toolCallId = `${parentThreadId}::task-1`;
  return [
    ...sequence(parentThreadId, runId).runStarted().build(),
    ...cards.map((card) =>
      subAgentCard(parentThreadId, runId, { toolCallId, childThreadId, ...card }),
    ),
  ];
}

const WORKING_CARD = {
  status: 'running',
  heading: '\u2022 Sub-agent working',
  latest: 'Auditing',
} as const;

const COMPLETED_CARD = {
  status: 'completed',
  heading: '\u2022 Sub-agent completed',
  latest: 'No TODOs left in the repository.',
} as const;

/**
 * A linked sub-agent whose second card update carries the same content — what a
 * status-only ACP `tool_call_update` produces after the bridge fills the gap.
 */
export function subAgentStatusOnlyUpdate(
  parentThreadId = 'parent',
  childThreadId = 'child',
): EventSequenceEntry[] {
  return linkedSubAgentSequence(parentThreadId, childThreadId, [WORKING_CARD, WORKING_CARD]);
}

/** A sub-agent that completes; its child thread then reports itself idle. */
export function subAgentTerminalThenIdleThread(
  parentThreadId = 'parent',
  childThreadId = 'child',
): EventSequenceEntry[] {
  return linkedSubAgentSequence(parentThreadId, childThreadId, [WORKING_CARD, COMPLETED_CARD]);
}

/**
 * A task tool that starts as an ordinary tool call and is only recognised as a
 * sub-agent afterwards — the ordering a bridge produces when the first ACP update
 * carries no task payload.
 */
export function spawnToolThenSubAgentCard(
  parentThreadId = 'parent',
  childThreadId = 'child',
): EventSequenceEntry[] {
  const runId = `${parentThreadId}::run-1`;
  const toolCallId = `${parentThreadId}::task-1`;
  return [
    ...sequence(parentThreadId, runId)
      .runStarted()
      .toolCall('spawnAgent', '{"prompt":"audit the repo"}', { toolCallId })
      .build(),
    subAgentCard(parentThreadId, runId, {
      toolCallId,
      childThreadId,
      status: 'running',
      heading: '\u2022 Sub-agent working',
      latest: 'Reading src/math.ts',
    }),
  ];
}

/** A sub-agent that itself spawns a sub-agent, so the child thread has its own card. */
export function nestedSubAgent(
  parentThreadId = 'parent',
  childThreadId = 'child',
  grandChildThreadId = 'grandchild',
): EventSequenceEntry[] {
  const childRunId = `${childThreadId}::run-1`;
  return [
    ...linkedSubAgentSequence(parentThreadId, childThreadId, [WORKING_CARD]),
    ...sequence(childThreadId, childRunId).runStarted().build(),
    subAgentCard(childThreadId, childRunId, {
      toolCallId: `${childThreadId}::task-1`,
      childThreadId: grandChildThreadId,
      status: 'running',
      heading: '\u2022 Sub-agent working',
      latest: 'Running npm test',
    }),
  ];
}

/** One card update for a sub-agent identified by its slot in the turn. */
interface SubAgentStep {
  slot: number;
  childThreadId?: string;
  status: 'running' | 'completed';
  latest: string;
}

function turnCards(
  parentThreadId: string,
  runId: string,
  turnIndex: number,
  steps: SubAgentStep[],
): EventSequenceEntry[] {
  return steps.map((step) =>
    subAgentCard(parentThreadId, runId, {
      toolCallId: `${parentThreadId}::turn-${String(turnIndex)}-task-${String(step.slot)}`,
      childThreadId: step.childThreadId,
      status: step.status,
      heading: step.status === 'completed' ? '\u2022 Sub-agent completed' : '\u2022 Sub-agent working',
      latest: step.latest,
    }),
  );
}

/**
 * One turn that runs two sub-agents at the same time, interleaving their updates
 * the way two concurrent task tools actually report.
 */
export function parallelSubAgentsInOneTurn(parentThreadId = 'parent'): {
  start: EventSequenceEntry[];
  interleaved: EventSequenceEntry[];
  finish: EventSequenceEntry[];
} {
  const runId = `${parentThreadId}::run-1`;
  const cards = (steps: SubAgentStep[]) => turnCards(parentThreadId, runId, 1, steps);

  return {
    start: [
      ...sequence(parentThreadId, runId)
        .runStarted()
        .textMessage('Splitting this in two.', { messageId: `${parentThreadId}::msg-1` })
        .build(),
      ...cards([
        { slot: 1, childThreadId: 'child-a', status: 'running', latest: 'Auditing deps' },
        { slot: 2, childThreadId: 'child-b', status: 'running', latest: 'Reading tests' },
      ]),
    ],
    // Both report progress out of order, and one finishes while the other works.
    interleaved: [
      ...cards([{ slot: 2, childThreadId: 'child-b', status: 'running', latest: 'Running npm test' }]),
      ...cards([{ slot: 1, childThreadId: 'child-a', status: 'running', latest: 'Checking lockfile' }]),
      ...cards([{ slot: 2, childThreadId: 'child-b', status: 'completed', latest: '12 tests passed' }]),
      ...cards([{ slot: 1, childThreadId: 'child-a', status: 'running', latest: 'Diffing versions' }]),
    ],
    finish: [
      ...cards([{ slot: 1, childThreadId: 'child-a', status: 'completed', latest: 'No drift found' }]),
      ...sequence(parentThreadId, runId)
        .textMessage('Both finished.', { messageId: `${parentThreadId}::msg-2` })
        .runFinished()
        .build(),
    ],
  };
}

/**
 * Two turns in one session, each spawning a sub-agent *between* two assistant
 * messages, so the card has to hold its place in the middle of the turn.
 */
export function turnsWithSubAgentInTheMiddle(parentThreadId = 'parent'): {
  turnOne: EventSequenceEntry[];
  turnTwo: EventSequenceEntry[];
} {
  const turn = (index: number, childThreadId: string): EventSequenceEntry[] => {
    const runId = `${parentThreadId}::run-${String(index)}`;
    const prefix = `${parentThreadId}::t${String(index)}`;
    return [
      ...sequence(parentThreadId, runId)
        .runStarted()
        .textMessage(`Prompt ${String(index)}`, { messageId: `${prefix}-user`, role: 'user' })
        .textMessage(`Before the sub-agent, turn ${String(index)}.`, {
          messageId: `${prefix}-before`,
        })
        .build(),
      ...turnCards(parentThreadId, runId, index, [
        { slot: 1, childThreadId, status: 'running', latest: `Working on turn ${String(index)}` },
      ]),
      ...turnCards(parentThreadId, runId, index, [
        { slot: 1, childThreadId, status: 'completed', latest: `Finished turn ${String(index)}` },
      ]),
      ...sequence(parentThreadId, runId)
        .textMessage(`After the sub-agent, turn ${String(index)}.`, {
          messageId: `${prefix}-after`,
        })
        .runFinished()
        .build(),
    ];
  };

  return { turnOne: turn(1, 'child-1'), turnTwo: turn(2, 'child-2') };
}
