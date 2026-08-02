import { requireTestValue } from '@shared/testing/requireTestValue';
import { EventType, type AGUIEvent } from '@ag-ui/core';
import { mapChat, toRawThread } from '@bridge/mapping/chatMapping';
import { resolveSubAgentState } from '@bridge/mapping/chatMappingPlanParsing';
import type { Chat, ChatSummary } from '@bridge/types/types';
import {
  didAssistantMessageProgress,
  isChatLikelyRunning,
  isThreadOrSubAgentRunning,
  OPENING_CHAT_ACTIVITY_TITLE,
  retireOpeningChatActivity,
} from '../../../features/chat/helpers/status';
import { assessChatSync } from '../../../features/chat/session/controllers/chatSyncController';
import { registerTestHarnessMatchers } from '@shared/testing/AssertionHelpers';
import { TestableThreadState } from '@shared/testing/TestableThreadState';
import { sequence } from '@shared/testing/EventSequenceBuilder';
import {
  lateClassifiedSubAgent,
  nestedSubAgent,
  parallelSubAgentsInOneTurn,
  parentOnlySubAgent,
  spawnToolThenSubAgentCard,
  subAgentStatusOnlyUpdate,
  subAgentWithToolPayloads,
  subAgentTerminalThenIdleThread,
  promptAfterSnapshot,
  streamThenAuthoritativeSnapshot,
  toolContentAfterRenamingSnapshot,
  multiTurnReplayedHistory,
  turnsWithSubAgentInTheMiddle,
} from '@shared/testing/fixtures/regressions';

registerTestHarnessMatchers();

describe('Harness matcher regressions', () => {
  it('does not skip empty message ids in ordering assertions', () => {
    const state = new TestableThreadState();

    expect(() => expect(state).toHaveMessagesInOrder('t1', '', 'missing')).toThrow(
      '"" is not rendered',
    );
  });
});

/**
 * Every scenario here reproduces a defect that reached a user. They are written
 * against the sequence of events the bridge actually emits, so a regression fails
 * here rather than on a device.
 */

/** Persist what is currently rendered, the way the bridge stores a finished turn. */
function persistProjection(state: TestableThreadState, threadId: string): void {
  state.setPersistedChat({
    ...state.buildSyntheticChat(threadId),
    messages: state.projectTranscript(threadId).messages,
  });
}

describe('Streaming and snapshot sequencing', () => {
  it('keeps the full assistant text when a snapshot lands mid-stream', () => {
    // Regression: ordered `parts` left over from streaming shadowed the
    // authoritative `content`, truncating the bubble to its first chunk.
    const state = new TestableThreadState();
    state.applySequence(streamThenAuthoritativeSnapshot('t1', 'run-1'));

    const message = requireTestValue(state.getMessageContents('t1')[0], 'streamed message');
    expect(message.content).toBe("This needs a wider search, so I'll delegate to a sub-agent.");

    const projected = requireTestValue(
      state.projectTranscript('t1').messages[0],
      'indexed test value',
    );
    expect(projected.parts).toBeUndefined();
  });

  it('keeps a prompt that was sent after the snapshot was built', () => {
    // Regression: an authoritative snapshot replaced the whole transcript, so a
    // prompt already persisted but not yet in the snapshot vanished.
    const state = new TestableThreadState();
    const { events, chat } = promptAfterSnapshot('t1', 'run-1');
    state.setPersistedChat(chat);
    state.applySequence(events);

    const contents = state.getMessageContents('t1').map((m) => m.content);
    expect(contents).toContain('first prompt');
    expect(contents).toContain('second prompt');
    expect(state.findDuplicateIds('t1')).toEqual([]);
  });

  it('keeps every replayed turn separate instead of merging them by role', () => {
    // Regression: replaying history through `session/load` collapsed all past
    // turns into one message per role.
    const state = new TestableThreadState();
    const { events, chat } = multiTurnReplayedHistory('t1');
    state.setPersistedChat(chat);
    state.applySequence(events);

    const users = state
      .getMessageContents('t1')
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(users).toEqual(['turn one', 'turn two', 'turn three']);
    expect(state.findDuplicateIds('t1')).toEqual([]);
  });

  it('prefers the live copy when a streaming message diverges from the persisted one', () => {
    // Regression: the merge only accepted live text that extended the persisted
    // text, so an agent that rewrote a sentence left the stale version on screen.
    const state = new TestableThreadState();
    const messageId = 't1::msg-1';
    state.applySequence(
      sequence('t1', 'run-1')
        .runStarted()
        .textStart(messageId, 'assistant')
        .textContent('The answer is 43', messageId)
        .build(),
    );
    state.setPersistedChat({
      ...state.buildSyntheticChat('t1'),
      messages: [
        {
          id: messageId,
          role: 'assistant',
          content: 'The answer is 42',
          createdAt: new Date(1).toISOString(),
        },
      ],
    });

    expect(state.getMessageContents('t1').map((m) => m.content)).toEqual(['The answer is 43']);
  });

  it('keeps the persisted copy when it is strictly ahead of the live one', () => {
    const state = new TestableThreadState();
    const messageId = 't1::msg-1';
    state.applySequence(
      sequence('t1', 'run-1')
        .runStarted()
        .textStart(messageId, 'assistant')
        .textContent('The answer', messageId)
        .build(),
    );
    state.setPersistedChat({
      ...state.buildSyntheticChat('t1'),
      messages: [
        {
          id: messageId,
          role: 'assistant',
          content: 'The answer is 42',
          createdAt: new Date(1).toISOString(),
        },
      ],
    });

    expect(state.getMessageContents('t1').map((m) => m.content)).toEqual(['The answer is 42']);
  });

  it('keeps earlier turns when a resumed thread snapshots only its newest turn', () => {
    // Regression: an agent that resumes a thread snapshots just the turn it ran.
    // That snapshot shares no ids with the stored history, so treating it as the
    // whole transcript erased every earlier turn the instant a follow-up was sent.
    const state = new TestableThreadState();
    state.setPersistedChat({
      ...state.buildSyntheticChat('t1'),
      messages: [
        {
          id: 't1:h1:User',
          role: 'user',
          content: 'old prompt',
          createdAt: new Date(1).toISOString(),
        },
        {
          id: 't1:h2:Agent',
          role: 'assistant',
          content: 'old answer',
          createdAt: new Date(2).toISOString(),
        },
      ],
    });

    state.applySequence(sequence('t1', 't1::run-9').runStarted().build());
    state.applySequence([
      {
        threadId: 't1',
        runId: 't1::run-9',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [{ id: 't1::u9', role: 'user', content: 'new prompt' }],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveMessagesInOrder('t1', 't1:h1:User', 't1:h2:Agent', 't1::u9');
    expect(state).toHaveNoDuplicateIds('t1');
    expect(state).toHaveNoDuplicateContent('t1');
  });

  it('does not duplicate history when a snapshot repeats it under new ids', () => {
    // The same guard must not resurrect history the snapshot already contains,
    // which happens when a replay re-ids the messages it restores.
    const state = new TestableThreadState();
    state.setPersistedChat({
      ...state.buildSyntheticChat('t1'),
      messages: [
        { id: 'old-1', role: 'user', content: 'old prompt', createdAt: new Date(1).toISOString() },
        {
          id: 'old-2',
          role: 'assistant',
          content: 'old answer',
          createdAt: new Date(2).toISOString(),
        },
      ],
    });

    state.applySequence(sequence('t1', 't1::run-9').runStarted().build());
    state.applySequence([
      {
        threadId: 't1',
        runId: 't1::run-9',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            { id: 'new-1', role: 'user', content: 'old prompt' },
            { id: 'new-2', role: 'assistant', content: 'old answer' },
            { id: 'new-3', role: 'user', content: 'new prompt' },
          ],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveMessageCount('t1', 3);
    expect(state).toHaveNoDuplicateContent('t1');
  });

  it('never renders the same message twice across a multi-turn session', () => {
    // Follow-up messages in one session must not make earlier ones pop in and out:
    // after every turn the whole history is still there, in order, exactly once.
    const state = new TestableThreadState();
    const expectedIds: string[] = [];

    for (let turn = 1; turn <= 4; turn += 1) {
      state.applySequence(
        sequence('t1', `run-${String(turn)}`)
          .runStarted()
          .textMessage(`prompt ${String(turn)}`, {
            messageId: `t1::user-${String(turn)}`,
            role: 'user',
          })
          .textMessage(`answer ${String(turn)}`, { messageId: `t1::msg-${String(turn)}` })
          .runFinished()
          .build(),
      );
      expectedIds.push(`t1::user-${String(turn)}`, `t1::msg-${String(turn)}`);

      expect(state).toHaveMessageCount('t1', expectedIds.length);
      expect(state).toHaveMessagesInOrder('t1', ...expectedIds);
      expect(state).toHaveNoDuplicateIds('t1');
      expect(state).toHaveNoDuplicateContent('t1');
      persistProjection(state, 't1');
    }

    // The first turn survives all three follow-ups verbatim.
    expect(state).toHaveMessageAt('t1', 0, { id: 't1::user-1', content: 'prompt 1' });
  });
});

describe('Sub-agent card lifecycle', () => {
  it('removes a tool card that only later turns out to be a sub-agent', () => {
    // A task tool whose title is the prompt cannot be classified until its first
    // task header arrives, so the bridge opens an ordinary tool card first. Once
    // the sub-agent card lands that tool card must go, not sit beside it.
    const state = new TestableThreadState();
    const { toolOnly, classified } = lateClassifiedSubAgent('parent', 'child');

    state.applySequence(toolOnly);
    expect(state).toHaveMessageCount('parent', 1);

    state.applySequence(classified);
    expect(state).toHaveMessageCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'running' });
    const { messages } = state.projectTranscript('parent');
    expect(
      messages.some(
        (message) => message.role === 'assistant' && Boolean(message.toolCalls?.length),
      ),
    ).toBe(false);
  });

  it('never leaves a phantom tool card beside a sub-agent card', () => {
    // The card already renders the task payload. Tool text or a tool result for the
    // same call would render it a second time as an empty tool card.
    const state = new TestableThreadState();
    state.applySequence(subAgentWithToolPayloads('parent', 'child'));

    expect(state).toHaveMessageCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child');
    const { messages } = state.projectTranscript('parent');
    expect(messages.every((message) => message.role === 'activity')).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('raw payload');
  });

  it.each([
    { error: undefined, expectedStatus: 'completed' },
    { error: 'Tool failed', expectedStatus: 'failed' },
  ] as const)(
    'does not let a malformed terminal snapshot replace a live sub-agent card ($expectedStatus)',
    ({ error, expectedStatus }) => {
      // Regression: the bridge classified the task live, then its terminal snapshot
      // saw only the tool's newest plain-text update and rendered it as a generic
      // tool. The mobile projection keeps the already-known card as a final defense.
      const state = new TestableThreadState();
      const { classified } = lateClassifiedSubAgent('parent', 'child');
      state.applySequence(classified);
      state.applySequence(sequence('parent', 'parent::run-1').runFinished().build());
      state.applySequence([
        {
          threadId: 'parent',
          runId: 'parent::run-1',
          event: {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [
              {
                id: 'tool-call:parent::task-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: 'parent::task-1',
                    type: 'function',
                    function: { name: 'Research dependency options', arguments: '{}' },
                  },
                ],
              },
              {
                id: 'tool-result:parent::task-1',
                role: 'tool',
                toolCallId: 'parent::task-1',
                content: 'raw task result',
                error,
              },
            ],
          } as unknown as AGUIEvent,
        },
      ]);

      expect(state).toHaveMessageCount('parent', 1);
      expect(state).toHaveSubAgentCard('parent', 'child', { status: expectedStatus });
      expect(JSON.stringify(state.projectTranscript('parent').messages)).not.toContain(
        'Research dependency options',
      );
    },
  );

  it('does not let a successful wrapper snapshot overwrite a known child failure', () => {
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: 'subagent:parent::task-1',
          activityType: 'dappercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: error\n  Latest: Child failed',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'error',
            },
          },
        } as unknown as AGUIEvent,
      },
    ]);
    state.applySequence(sequence('parent', 'parent::run-1').runFinished().build());
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: 'tool-call:parent::task-1',
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'parent::task-1',
                  type: 'function',
                  function: { name: 'Research dependency options', arguments: '{}' },
                },
              ],
            },
            {
              id: 'tool-result:parent::task-1',
              role: 'tool',
              toolCallId: 'parent::task-1',
              content: 'wrapper completed',
            },
          ],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveMessageCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'error' });
    expect(state).toHaveSubAgentPreview('parent', 'Child failed');
  });

  it('classified authoritative snapshot replaces transient local status', () => {
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: 'subagent:parent::task-1',
          activityType: 'dappercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: failed\n  Latest: Child failed late',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'failed',
            },
          },
        } as unknown as AGUIEvent,
      },
    ]);
    state.applySequence(sequence('parent', 'parent::run-1').runFinished().build());
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: 'subagent:parent::task-1',
              role: 'activity',
              activityType: 'dappercode.subagent',
              content: {
                text: '• Sub-agent completed\n  Status: completed\n  Latest: Wrapper completed',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'completed',
                },
              },
            },
          ],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveMessageCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'completed' });
    expect(state).toHaveSubAgentPreview('parent', 'Wrapper completed');
  });

  it('retasked sub-agent snapshot clears a previous failure', () => {
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: 'subagent:parent::task-1',
          activityType: 'dappercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: failed\n  Latest: First attempt failed',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'failed',
            },
          },
        } as unknown as AGUIEvent,
      },
    ]);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: 'subagent:parent::task-1',
              role: 'activity',
              activityType: 'dappercode.subagent',
              content: {
                text: '• Sub-agent working\n  Status: running\n  Latest: Trying again',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'running',
                },
              },
            },
          ],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'running' });
    expect(state).toHaveSubAgentPreview('parent', 'Trying again');
  });

  it('final retask snapshot converges without an intermediate running update', () => {
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: 'subagent:parent::task-1',
          activityType: 'dappercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: failed\n  Latest: First attempt failed',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'failed',
            },
          },
        } as unknown as AGUIEvent,
      },
    ]);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: 'subagent:parent::task-1',
              role: 'activity',
              activityType: 'dappercode.subagent',
              content: {
                text: '• Sub-agent completed\n  Status: completed\n  Latest: Retry passed',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'completed',
                },
              },
            },
          ],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'completed' });
    expect(state).toHaveSubAgentPreview('parent', 'Retry passed');
  });

  it('keeps the card when the terminal snapshot updates it to done', () => {
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);
    state.applySequence([
      {
        threadId: 'parent',
        runId: 'parent::run-1',
        event: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: 'subagent:parent::task-1',
              role: 'activity',
              activityType: 'dappercode.subagent',
              content: {
                text: '• Sub-agent completed\n  Status: completed\n  Latest: Done',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'completed',
                },
              },
            },
          ],
        } as unknown as AGUIEvent,
      },
    ]);

    expect(state).toHaveMessageCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'completed' });
    expect(state).toHaveNoDuplicateIds('parent');
  });

  it('never shows a sub-agent as starting, and shows it as openable', () => {
    // A card reading "starting" cannot be opened and looks stuck. The child thread
    // arrives with the task header, so the first card is already openable.
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);

    const card = requireTestValue(state.getSubAgentActivities('parent')[0], 'sub-agent card');
    expect(card).toBeTruthy();
    const text = String((card.content as { text?: string }).text).toLowerCase();
    expect(text).not.toContain('starting');
    expect(state.getSubAgentThreadIds('parent')).toContain('child');
  });

  it('replaces the spawn tool card with the sub-agent card', () => {
    // The task tool that launches a sub-agent must not leave a dead "spawnAgent"
    // tool card sitting above the card that reports the same work.
    const state = new TestableThreadState();
    state.applySequence(spawnToolThenSubAgentCard('parent', 'child'));

    expect(state).toHaveMessageCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'running' });
    const { messages } = state.projectTranscript('parent');
    expect(
      messages.some(
        (message) => message.role === 'assistant' && Boolean(message.toolCalls?.length),
      ),
    ).toBe(false);
    expect(messages.some((message) => message.id.startsWith('tool-call:'))).toBe(false);
  });

  it('shows only the latest step on the parent card, not an accumulating list', () => {
    // The parent transcript stays scannable: one rolling line. The full history
    // belongs in the sub-agent detail view.
    const state = new TestableThreadState();
    const steps = parentOnlySubAgent('parent', ['Reading src/math.ts', 'Running npm test']);

    state.applySequence(steps.start);
    steps.progress.forEach((step) => {
      state.applySequence([step]);
    });

    expect(state).toHaveSubAgentCount('parent', 1);
    expect(state).toHaveSubAgentPreview('parent', 'Running npm test');
    const card = requireTestValue(state.getSubAgentActivities('parent')[0], 'sub-agent card');
    expect(String((card.content as { text?: string }).text)).not.toContain('Reading src/math.ts');
  });

  it('keeps a nested sub-agent card on its own thread and out of the parent', () => {
    // A sub-agent that spawns its own sub-agent reports that on the child thread.
    // Surfacing it on the parent would make one card look like two sub-agents.
    const state = new TestableThreadState();
    state.applySequence(nestedSubAgent('parent', 'child', 'grandchild'));

    expect(state).toHaveSubAgentCount('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child');
    expect(state).toHaveSubAgentCount('child', 1);
    expect(state).toHaveSubAgentCard('child', 'grandchild', { preview: 'Running npm test' });
  });

  it('reports progress while the sub-agent works instead of a static start label', () => {
    // Regression: the card sat on "Starting sub-agent" for the whole run and then
    // jumped to done, because it only refreshed when the task state changed.
    const state = new TestableThreadState();
    const steps = parentOnlySubAgent('parent', ['Searching package 1', 'Searching package 7']);

    state.applySequence(steps.start);
    expect(state).toHaveSubAgentPreview('parent', 'Searching package 1');

    state.applySequence(steps.progress);
    expect(state).toHaveSubAgentPreview('parent', 'Searching package 7');

    state.applySequence(steps.finish);
    expect(state).toHaveSubAgentPreview('parent', 'No TODOs left');
    expect(state.getRunningSubAgentCount('parent')).toBe(0);
  });

  it('never shows the opaque child thread id to the user', () => {
    // Regression: the card body printed `Thread: v1.c3R1Yg…`.
    const state = new TestableThreadState();
    const steps = parentOnlySubAgent('parent', ['Working']);
    state.applySequence(steps.start);

    const card = requireTestValue(state.getSubAgentActivities('parent')[0], 'sub-agent card');
    const text = (card.content as { text?: string }).text ?? '';
    expect(text).not.toMatch(/Thread:/);
    expect(text).not.toMatch(/v1\./);
  });

  it('keeps the child link when an update only changes status', () => {
    // Regression: previews read the per-update content, which is absent on a
    // status-only update, so a linked sub-agent looked unlinked and the
    // "Open agent chat" affordance disappeared mid-run.
    const state = new TestableThreadState();
    state.applySequence(subAgentStatusOnlyUpdate('parent', 'child'));

    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'running' });
    const card = requireTestValue(state.getSubAgentActivities('parent')[0], 'sub-agent card');
    const meta = (card.content as { subAgent?: { receiverThreadIds?: string[] } }).subAgent;
    expect(meta?.receiverThreadIds).toContain('child');
  });

  it('keeps a completed sub-agent completed when its thread goes back to idle', () => {
    // Regression: the card rewrote its status from the child thread's chat status,
    // so a finished sub-agent read "Sub-agent completed / Status: idle".
    const state = new TestableThreadState();
    state.applySequence(subAgentTerminalThenIdleThread('parent', 'child'));
    state.setThreadStatus('child', 'idle');

    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'completed' });
    const card = requireTestValue(state.getSubAgentActivities('parent')[0], 'sub-agent card');
    const text = (card.content as { text?: string }).text ?? '';
    expect(text).toContain('Status: completed');
    expect(text).not.toContain('Status: idle');
  });

  it('keeps child output out of the parent transcript', () => {
    const state = new TestableThreadState();
    state.applySequence(subAgentStatusOnlyUpdate('parent', 'child'));
    state.applySequence(
      sequence('child', 'child::run-1')
        .runStarted()
        .textMessage('child only detail', { messageId: 'child::msg-1' })
        .build(),
    );

    const parentText = state
      .getMessageContents('parent')
      .map((m) => m.content)
      .join('\n');
    expect(parentText).not.toContain('child only detail');
    expect(state.getMessageContents('child').map((m) => m.content)).toContain('child only detail');
  });
});

describe('Tool rendering', () => {
  it('does not print the same tool output twice', () => {
    // Regression: the plain text and the structured rendering of one payload were
    // both appended, so every tool card repeated itself.
    const state = new TestableThreadState();
    const toolCallId = 't1::tc-1';
    state.applySequence(
      sequence('t1', 'run-1').runStarted().toolCall('read', '{}', { toolCallId }).build(),
    );
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'dappercode.dev/tool-text',
      value: { toolCallId, revision: 'r1', content: 'export function add() {}\n' },
    } as never);
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'dappercode.dev/tool-content',
      value: {
        toolCallId,
        revision: 'r2',
        content: [
          { type: 'content', content: { type: 'text', text: 'export function add() {}\n' } },
        ],
        locations: [{ path: 'src/math.ts' }],
      },
    } as never);

    const toolText = state
      .getMessageContents('t1')
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join('\n');
    expect(toolText.match(/export function add\(\) \{\}/g)).toHaveLength(1);
    expect(toolText).toContain('[location: src/math.ts]');
  });

  it('never renders raw JSON for structured tool content', () => {
    // Regression: snapshot-projected tool cards showed `{"content":[{"type"…`.
    const state = new TestableThreadState();
    const toolCallId = 't1::tc-1';
    state.applySequence(
      sequence('t1', 'run-1').runStarted().toolCall('edit', '{}', { toolCallId }).build(),
    );
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'dappercode.dev/tool-content',
      value: {
        toolCallId,
        revision: 'r1',
        content: [{ type: 'diff', path: 'src/math.ts', oldText: 'a', newText: 'b' }],
        locations: [],
      },
    } as never);

    const toolText = state
      .getMessageContents('t1')
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join('\n');
    expect(toolText).not.toContain('{"content"');
    expect(toolText).not.toContain('"type":"diff"');
    expect(toolText).toContain('[diff: src/math.ts]');
  });

  it('keeps interior lines of a diff that also appear in the plain text', () => {
    // Guard for the fix above: deduplicating line by line would punch holes in a
    // diff whose body legitimately repeats a line the plain text also contains.
    const state = new TestableThreadState();
    const toolCallId = 't1::tc-1';
    state.applySequence(
      sequence('t1', 'run-1').runStarted().toolCall('edit', '{}', { toolCallId }).build(),
    );
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'dappercode.dev/tool-text',
      value: { toolCallId, revision: 'r1', content: '}' },
    } as never);
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'dappercode.dev/tool-content',
      value: {
        toolCallId,
        revision: 'r2',
        content: [
          {
            type: 'diff',
            path: 'src/math.ts',
            oldText: 'function a() {\n}\n',
            newText: 'function a() {\n  return 1;\n}\n',
          },
        ],
        locations: [],
      },
    } as never);

    const toolText = state
      .getMessageContents('t1')
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join('\n');
    expect(toolText).toContain('[diff: src/math.ts]');
    expect(toolText).toContain('return 1;');
    expect(toolText).toContain('function a() {');
  });

  it('replaces the previous structured block when a tool revises its output', () => {
    const state = new TestableThreadState();
    const toolCallId = 't1::tc-1';
    state.applySequence(
      sequence('t1', 'run-1').runStarted().toolCall('search', '{}', { toolCallId }).build(),
    );
    for (const [revision, path] of [
      ['r1', 'src/a.ts'],
      ['r2', 'src/b.ts'],
    ] as const) {
      state.apply('t1', 'run-1', {
        type: EventType.CUSTOM,
        name: 'dappercode.dev/tool-content',
        value: { toolCallId, revision, content: [], locations: [{ path }] },
      } as never);
    }

    const toolText = state
      .getMessageContents('t1')
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join('\n');
    expect(toolText).toContain('[location: src/b.ts]');
    expect(toolText).not.toContain('[location: src/a.ts]');
  });

  it('renders one row for a tool whose content lands after a renaming snapshot', () => {
    // Regression: a `messages` snapshot re-states the turn under the agent's own
    // ids but left the call-to-message bookkeeping pointing at the streamed ids,
    // so the tool's final content resurrected the pre-snapshot message at the end
    // of the transcript. The tool rendered twice and React saw two children with
    // the same key.
    const state = new TestableThreadState();
    const { events, toolCallId } = toolContentAfterRenamingSnapshot('t1');
    state.applySequence(events);

    const carryingCallId = state
      .getThreadState('t1')
      ?.messages.filter(
        (message) =>
          (message.role === 'tool' && message.toolCallId === toolCallId) ||
          (message.role === 'assistant' &&
            (message.toolCalls ?? []).some((call) => call.id === toolCallId)),
      );
    expect(carryingCallId?.map((message) => message.id)).toEqual([
      't1::item-call',
      't1::item-result',
    ]);

    const { items } = state.projectTranscript('t1');
    const renderKeys = items.map((item) => (item.kind === 'message' ? item.renderKey : item.id));
    expect(new Set(renderKeys).size).toBe(renderKeys.length);
    expect(
      items.filter((item) => item.kind === 'toolInvocation' && item.id === toolCallId),
    ).toHaveLength(1);

    // The completed output still belongs to the one row that survives.
    const invocations = items.flatMap((item) =>
      item.kind === 'toolInvocation' && item.id === toolCallId ? [item.invocation] : [],
    );
    const invocation = requireTestValue(invocations[0], 'tool invocation');
    expect(invocation.title).toContain('node -e');
    expect(invocation.status).toBe('completed');
    expect(invocation.terminals.map((terminal) => terminal.output)).toEqual(['harness ok 42\n']);
    expect(state.findDuplicateIds('t1')).toEqual([]);
  });

  it('keeps one row when narration splits a tool call from its result', () => {
    // Regression: display items only deduplicated tool calls inside a contiguous
    // run of tool messages, so an assistant message between the call and its
    // result produced two rows keyed by the same tool call id.
    const state = new TestableThreadState();
    const toolCallId = 'call_01_split';
    state.apply('t1', 'run-1', {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: 'bash',
    } as never);
    state.applySequence(
      sequence('t1', 'run-1')
        .textMessage('Running the snippet now.', { messageId: 't1::narration' })
        .build(),
    );
    state.apply('t1', 'run-1', {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: 't1::result',
      content: 'harness ok 42\n',
    } as never);

    const { items } = state.projectTranscript('t1');
    const renderKeys = items.map((item) => (item.kind === 'message' ? item.renderKey : item.id));
    expect(new Set(renderKeys).size).toBe(renderKeys.length);

    const invocations = items.flatMap((item) =>
      item.kind === 'toolInvocation' && item.id === toolCallId ? [item.invocation] : [],
    );
    expect(invocations).toHaveLength(1);
    expect(requireTestValue(invocations[0], 'indexed test value').textLines.join('\n')).toContain(
      'harness ok 42',
    );
  });
});

describe('Long-session bookkeeping', () => {
  it('forgets tool bookkeeping for messages trimmed out of a long thread', () => {
    // Regression: trimming the head of a long thread left dangling references, so
    // later events resurrected old messages at the end of the transcript.
    const state = new TestableThreadState();
    const staleToolCallId = 't1::tc-old';
    state.applySequence(
      sequence('t1', 'run-1')
        .runStarted()
        .toolCall('read', '{}', { toolCallId: staleToolCallId })
        .build(),
    );

    for (let index = 0; index < 140; index += 1) {
      state.apply('t1', 'run-1', {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: `filler-${String(index)}`,
        role: 'assistant',
        delta: 'x',
      } as never);
    }

    const threadState = state.getThreadState('t1');
    expect(threadState?.messages.length).toBeLessThanOrEqual(128);
    expect(threadState?.toolCallMessageIdByCallId[staleToolCallId]).toBeUndefined();
    expect(Object.keys(threadState?.runByMessageId ?? {}).length).toBe(
      threadState?.messages.length,
    );
    expect(state.findDuplicateIds('t1')).toEqual([]);
  });
});

describe('Sub-agents across turns', () => {
  it('tracks two sub-agents running in parallel in a single turn', () => {
    // Two concurrent task tools report out of order. Each needs its own card, and
    // one finishing must not disturb the other's state.
    const state = new TestableThreadState();
    const turn = parallelSubAgentsInOneTurn('parent');

    state.applySequence(turn.start);
    expect(state).toHaveSubAgentCount('parent', 2);
    expect(state).toHaveRunningSubAgents('parent', 2);
    expect(state).toHaveSubAgentCard('parent', 'child-a', { preview: 'Auditing deps' });
    expect(state).toHaveSubAgentCard('parent', 'child-b', { preview: 'Reading tests' });

    // Interleaved updates: each card tracks its own sub-agent, not the last one seen.
    turn.interleaved.forEach((event) => {
      state.applySequence([event]);
    });
    expect(state).toHaveSubAgentCount('parent', 2);
    expect(state).toHaveRunningSubAgents('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child-a', {
      status: 'running',
      preview: 'Diffing versions',
    });
    expect(state).toHaveSubAgentCard('parent', 'child-b', {
      status: 'completed',
      preview: '12 tests passed',
    });

    state.applySequence(turn.finish);
    expect(state).toHaveSubAgentCount('parent', 2);
    expect(state).toHaveRunningSubAgents('parent', 0);
    expect(state).toHaveNoDuplicateIds('parent');
    expect(state).toHaveNoDuplicateContent('parent');
  });

  it("keeps each turn's sub-agent card in the middle of its own turn", () => {
    // Two turns, each spawning a sub-agent between two assistant messages. Turn one
    // is persisted before turn two starts, the way the bridge stores a finished
    // turn, so this exercises the persisted+live merge with cards in the middle.
    const state = new TestableThreadState();
    const { turnOne, turnTwo } = turnsWithSubAgentInTheMiddle('parent');

    state.applySequence(turnOne);
    expect(state).toHaveSubAgentCount('parent', 1);
    expect(state).toHaveMessagesInOrder(
      'parent',
      'parent::t1-before',
      'subagent:parent::turn-1-task-1',
      'parent::t1-after',
    );

    persistProjection(state, 'parent');
    state.applySequence(turnTwo);

    expect(state).toHaveSubAgentCount('parent', 2);
    expect(state).toHaveSubAgentCard('parent', 'child-1', { status: 'completed' });
    expect(state).toHaveSubAgentCard('parent', 'child-2', { status: 'completed' });
    // Turn one's messages keep their place; nothing pops to the end.
    expect(state).toHaveMessagesInOrder(
      'parent',
      'parent::t1-before',
      'subagent:parent::turn-1-task-1',
      'parent::t1-after',
      'parent::t2-before',
      'subagent:parent::turn-2-task-1',
      'parent::t2-after',
    );
    expect(state).toHaveNoDuplicateIds('parent');
    expect(state).toHaveNoDuplicateContent('parent');
  });

  it("does not resurrect an earlier turn's sub-agent as running", () => {
    // A completed card from turn one must stay completed once turn two starts,
    // otherwise the parent reports work that already finished -- and with the
    // parent following its sub-agents, that would spin the header indefinitely.
    const state = new TestableThreadState();
    const { turnOne, turnTwo } = turnsWithSubAgentInTheMiddle('parent');

    state.applySequence(turnOne);
    expect(state).toHaveRunningSubAgents('parent', 0);
    persistProjection(state, 'parent');

    // Mid-turn-two the only running sub-agent is turn two's.
    const finishIndex = turnTwo.findIndex((entry) => {
      const content = (entry.event as { content?: { text?: string } }).content;
      return content?.text?.includes('Finished turn 2') ?? false;
    });
    expect(finishIndex).toBeGreaterThan(0);
    state.applySequence(turnTwo.slice(0, finishIndex));

    expect(state).toHaveRunningSubAgents('parent', 1);
    expect(state).toHaveSubAgentCard('parent', 'child-1', { status: 'completed' });
    expect(state).toHaveSubAgentCard('parent', 'child-2', { status: 'running' });
  });
});

describe('Settled sub-agents after a bridge restart', () => {
  /**
   * Reproduces "a long complete session showed as in progress".
   *
   * A `<task …>` header is only refreshed while the run that emitted it is alive. Restarting
   * the bridge replays the thread from history, which settles the tool call to `completed`
   * while leaving the last header it ever saw reading `state="running"`. Trusting the header
   * there left every finished thread reporting a working sub-agent, on every future read.
   */
  it('reports a settled sub-agent tool as completed even when its header still says running', () => {
    const mapped = mapChat(
      toRawThread({
        id: 'parent-restarted',
        acpSnapshot: {
          version: 2,
          timeline: [{ sequence: 0, kind: 'tool', canonicalId: 'call-task-1' }],
          messages: [],
          tools: [
            {
              id: 'call-task-1',
              kind: 'think',
              status: 'completed',
              title: 'Task',
              content: '<task id="child-session" state="running">\nAudit the tests\n</task>',
              structuredContent: [],
              locations: [],
            },
          ],
          plan: [],
          usage: {},
          config: [],
          commands: [],
          session: {
            agentId: 'stub',
            threadId: 'parent-restarted',
            historyReconstruction: false,
          },
          active: { toolIds: [] },
        },
      }),
    );

    const message = requireTestValue(mapped.messages[0], 'indexed test value');
    if (message.role !== 'activity') {
      throw new Error('expected activity message');
    }
    expect(message.content.text).toContain('Sub-agent completed');
    expect(message.content.text).not.toContain('Sub-agent working');
    expect(message.content.subAgent).toMatchObject({ agentStatus: 'completed' });
  });

  /** A failed child must not be laundered into a success just because the tool call ended. */
  it('keeps a failed header when the tool call settles', () => {
    expect(resolveSubAgentState('completed', 'failed')).toBe('failed');
    expect(resolveSubAgentState('completed', 'cancelled')).toBe('cancelled');
    expect(resolveSubAgentState('failed', 'running')).toBe('failed');
  });

  /** While the tool is genuinely in flight the header remains the better signal. */
  it('still trusts the header while the tool call is unsettled', () => {
    expect(resolveSubAgentState('in_progress', 'running')).toBe('running');
    expect(resolveSubAgentState('pending', 'completed')).toBe('completed');
    expect(resolveSubAgentState('in_progress', null)).toBe('running');
  });
});

describe('Reopened threads after a bridge restart', () => {
  const HOUR = 60 * 60 * 1000;

  function chatEndingWithPrompt(promptSentAt: number, updatedAt: number): Chat {
    return {
      id: 'thread-restarted',
      title: 'Old thread',
      createdAt: new Date(promptSentAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      status: null,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: { text: 'do the thing' },
          createdAt: new Date(promptSentAt).toISOString(),
        },
      ],
    } as unknown as Chat;
  }

  /**
   * Reproduces "a long complete session showed as in progress".
   *
   * Replaying a thread stamps `updatedAt` with the moment of the replay, so anchoring the
   * "probably still running" heuristic to it made every reopened thread whose last message is
   * a prompt look like it had just been sent — permanently "Working", with the composer
   * blocked and a run watchdog armed for a run that ended days ago.
   */
  it('does not resurrect an old unanswered prompt when a reload refreshes updatedAt', () => {
    const now = Date.now();
    expect(isChatLikelyRunning(chatEndingWithPrompt(now - 72 * HOUR, now))).toBe(false);
  });

  it('still reports a prompt that was just sent as running', () => {
    const now = Date.now();
    expect(isChatLikelyRunning(chatEndingWithPrompt(now - 1000, now))).toBe(true);
  });
});

describe('Sub-agent activity is scoped to the thread it belongs to', () => {
  function summary(id: string, parentThreadId: string | null, status: string): ChatSummary {
    return { id, title: id, parentThreadId, status } as unknown as ChatSummary;
  }

  function finishedChat(id: string): Chat {
    return {
      id,
      title: id,
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: new Date().toISOString(),
      status: null,
      messages: [
        {
          id: `${id}-a1`,
          role: 'assistant',
          content: { text: 'all done' },
          createdAt: '2026-07-18T12:00:00.000Z',
        },
      ],
    } as unknown as Chat;
  }

  /**
   * Reproduces a finished session opening as "in progress".
   *
   * `relatedAgentThreads` describes the whole tree of the thread that was open last and is
   * replaced asynchronously, so right after switching chats it still describes the previous
   * one. Counting any parented thread meant the chat you just opened inherited the previous
   * chat's live sub-agent and sat on "Working" with the composer blocked.
   */
  it('ignores a live sub-agent that belongs to a different thread', () => {
    const stale = [summary('other-child', 'other-parent', 'running')];
    expect(isThreadOrSubAgentRunning(finishedChat('thread-a'), stale)).toBe(false);
  });

  it('still reports its own live sub-agent, at any depth', () => {
    const own = [summary('child', 'thread-a', 'idle'), summary('grandchild', 'child', 'running')];
    expect(isThreadOrSubAgentRunning(finishedChat('thread-a'), own)).toBe(true);
  });

  it('ignores a live sibling of the sub-agent thread being viewed', () => {
    const tree = [summary('child-a', 'root', 'idle'), summary('child-b', 'root', 'running')];
    expect(isThreadOrSubAgentRunning(finishedChat('child-a'), tree)).toBe(false);
  });
});

describe('The "Opening chat" placeholder never outlives a load', () => {
  const opening = { tone: 'running', title: OPENING_CHAT_ACTIVITY_TITLE } as const;

  function chatWithStatus(status: Chat['status']): Chat {
    return {
      id: 'thread-a',
      title: 'Thread',
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
      status,
      messages: [],
    } as unknown as Chat;
  }

  /**
   * Reproduces a finished session opening as "in progress".
   *
   * Opening a chat writes a running placeholder before there is a transcript. A load that is
   * superseded while opening returns before it can report the thread's status, and the
   * revalidation that replaced it preserves runtime state and so deliberately leaves the
   * header alone. The placeholder is a running state, so the header rendered "Working" on a
   * finished thread — and nothing else reports on a thread that is not running, so it stayed.
   */
  it('retires the placeholder into the thread status', () => {
    expect(retireOpeningChatActivity(opening, chatWithStatus('idle'))).toEqual({
      tone: 'idle',
      title: 'Ready',
    });
    expect(retireOpeningChatActivity(opening, chatWithStatus('complete'))).toEqual({
      tone: 'complete',
      title: 'Turn completed',
    });
  });

  it('leaves a genuine running state alone', () => {
    const working = { tone: 'running', title: 'Working' } as const;
    expect(retireOpeningChatActivity(working, chatWithStatus('idle'))).toBe(working);
  });

  it('leaves a settled state alone', () => {
    const ready = { tone: 'idle', title: 'Ready' } as const;
    expect(retireOpeningChatActivity(ready, chatWithStatus('idle'))).toBe(ready);
  });
});

describe('Opening a finished session does not look like a live run', () => {
  function message(id: string, role: 'user' | 'assistant', text: string): Chat['messages'][number] {
    return {
      id,
      role,
      createdAt: '2024-03-02T00:00:00.000Z',
      content: text,
    };
  }

  function chatWith(messages: Chat['messages'], status: Chat['status'] = 'idle'): Chat {
    return {
      id: 'thread-a',
      title: 'Thread',
      createdAt: '2024-03-02T00:00:00.000Z',
      updatedAt: '2024-03-02T00:00:00.000Z',
      status,
      messages,
    } as unknown as Chat;
  }

  /**
   * Reproduces "a long complete session showed as in progress".
   *
   * Tapping a session selects it before its transcript exists, so the first poll compared a
   * replayed fourteen-message history against an empty placeholder. That read as the assistant
   * streaming, which armed the run watchdog, and the watchdog then kept the header on "Working"
   * for a session that had been finished for days.
   */
  it('does not mistake a replayed transcript for a streaming assistant', () => {
    const placeholder = chatWith([]);
    const replayed = chatWith([
      message('m1', 'user', 'spawn a subagent and add a multiply helper'),
      message('m2', 'assistant', 'Done. multiply is added and the tests pass.'),
    ]);

    expect(didAssistantMessageProgress(placeholder, replayed)).toBe(false);

    const assessment = assessChatSync(placeholder, replayed, false);
    expect(assessment.shouldShowRunning).toBe(false);
    expect(assessment.shouldRefreshWatchdog).toBe(false);
  });

  /**
   * Reproduces a complete answer followed by roughly one watchdog interval of false "Working"
   * state and a visible stop control.
   *
   * ACP snapshots expose the active run directly. Once that run is gone and the snapshot is
   * idle, an answer added since the previous poll is completed content, not proof of more work.
   */
  it('settles an answered idle snapshot even while the previous watchdog is active', () => {
    const prompt = message('m1', 'user', 'hello');
    const before = chatWith([prompt], 'running');
    const answered = chatWith([prompt, message('m2', 'assistant', 'Done.')]);

    expect(didAssistantMessageProgress(before, answered)).toBe(true);
    expect(assessChatSync(before, answered, true)).toMatchObject({
      terminal: true,
      shouldShowRunning: false,
      shouldRefreshWatchdog: false,
    });
  });

  it('still reports a genuinely growing assistant message when lifecycle status is unavailable', () => {
    const before = chatWith([
      message('m1', 'user', 'hello'),
      message('m2', 'assistant', 'Working on'),
    ]);
    const after = chatWith(
      [message('m1', 'user', 'hello'), message('m2', 'assistant', 'Working on it now')],
      'unknown' as Chat['status'],
    );

    expect(didAssistantMessageProgress(before, after)).toBe(true);
    expect(assessChatSync(before, after, false).shouldShowRunning).toBe(true);
  });

  it('still reports a newly appended assistant message', () => {
    const before = chatWith([message('m1', 'user', 'hello')]);
    const after = chatWith([message('m1', 'user', 'hello'), message('m2', 'assistant', 'On it.')]);

    expect(didAssistantMessageProgress(before, after)).toBe(true);
  });
});
