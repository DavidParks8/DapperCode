import { EventType, type AGUIEvent } from '@ag-ui/core';
import { registerTestHarnessMatchers } from '../AssertionHelpers';
import { TestableThreadState } from '../TestableThreadState';
import { sequence } from '../EventSequenceBuilder';
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
  multiTurnReplayedHistory,
  turnsWithSubAgentInTheMiddle,
} from '../fixtures/regressions';

registerTestHarnessMatchers();

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

    const [message] = state.getMessageContents('t1');
    expect(message.content).toBe("This needs a wider search, so I'll delegate to a sub-agent.");

    const projected = state.projectTranscript('t1').messages[0];
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

    expect(state.getMessageContents('t1').map((m) => m.content)).toEqual([
      'The answer is 43',
    ]);
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

    expect(state.getMessageContents('t1').map((m) => m.content)).toEqual([
      'The answer is 42',
    ]);
  });

  it('keeps earlier turns when a resumed thread snapshots only its newest turn', () => {
    // Regression: an agent that resumes a thread snapshots just the turn it ran.
    // That snapshot shares no ids with the stored history, so treating it as the
    // whole transcript erased every earlier turn the instant a follow-up was sent.
    const state = new TestableThreadState();
    state.setPersistedChat({
      ...state.buildSyntheticChat('t1'),
      messages: [
        { id: 't1:h1:User', role: 'user', content: 'old prompt', createdAt: new Date(1).toISOString() },
        { id: 't1:h2:Agent', role: 'assistant', content: 'old answer', createdAt: new Date(2).toISOString() },
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
        { id: 'old-2', role: 'assistant', content: 'old answer', createdAt: new Date(2).toISOString() },
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
          activityType: 'tethercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: error\n  Latest: Child failed',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'error',
              navigable: true,
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
          activityType: 'tethercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: failed\n  Latest: Child failed late',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'failed',
              navigable: true,
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
              activityType: 'tethercode.subagent',
              content: {
                text: '• Sub-agent completed\n  Status: completed\n  Latest: Wrapper completed',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'completed',
                  navigable: true,
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
          activityType: 'tethercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: failed\n  Latest: First attempt failed',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'failed',
              navigable: true,
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
              activityType: 'tethercode.subagent',
              content: {
                text: '• Sub-agent working\n  Status: running\n  Latest: Trying again',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'running',
                  navigable: true,
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
          activityType: 'tethercode.subagent',
          content: {
            text: '• Sub-agent failed\n  Status: failed\n  Latest: First attempt failed',
            subAgent: {
              toolCallId: 'parent::task-1',
              tool: 'spawnAgent',
              senderThreadId: 'parent',
              receiverThreadIds: ['child'],
              agentStatus: 'failed',
              navigable: true,
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
              activityType: 'tethercode.subagent',
              content: {
                text: '• Sub-agent completed\n  Status: completed\n  Latest: Retry passed',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'completed',
                  navigable: true,
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
              activityType: 'tethercode.subagent',
              content: {
                text: '• Sub-agent completed\n  Status: completed\n  Latest: Done',
                subAgent: {
                  toolCallId: 'parent::task-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'parent',
                  receiverThreadIds: ['child'],
                  agentStatus: 'completed',
                  navigable: true,
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
    // arrives with the task header, so the first card is already navigable.
    const state = new TestableThreadState();
    const { classified } = lateClassifiedSubAgent('parent', 'child');
    state.applySequence(classified);

    const [card] = state.getSubAgentActivities('parent');
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
    const [card] = state.getSubAgentActivities('parent');
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

    const [card] = state.getSubAgentActivities('parent');
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
    const [card] = state.getSubAgentActivities('parent');
    const meta = (card.content as { subAgent?: { navigable?: boolean } }).subAgent;
    expect(meta?.navigable).toBe(true);
  });

  it('keeps a completed sub-agent completed when its thread goes back to idle', () => {
    // Regression: the card rewrote its status from the child thread's chat status,
    // so a finished sub-agent read "Sub-agent completed / Status: idle".
    const state = new TestableThreadState();
    state.applySequence(subAgentTerminalThenIdleThread('parent', 'child'));
    state.setThreadStatus('child', 'idle');

    expect(state).toHaveSubAgentCard('parent', 'child', { status: 'completed' });
    const [card] = state.getSubAgentActivities('parent');
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

    const parentText = state.getMessageContents('parent').map((m) => m.content).join('\n');
    expect(parentText).not.toContain('child only detail');
    expect(state.getMessageContents('child').map((m) => m.content)).toContain(
      'child only detail',
    );
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
      name: 'tethercode.dev/tool-text',
      value: { toolCallId, revision: 'r1', content: 'export function add() {}\n' },
    } as never);
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'tethercode.dev/tool-content',
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
      name: 'tethercode.dev/tool-content',
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
      name: 'tethercode.dev/tool-text',
      value: { toolCallId, revision: 'r1', content: '}' },
    } as never);
    state.apply('t1', 'run-1', {
      type: EventType.CUSTOM,
      name: 'tethercode.dev/tool-content',
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
        name: 'tethercode.dev/tool-content',
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

  it('keeps each turn\'s sub-agent card in the middle of its own turn', () => {
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

  it('does not resurrect an earlier turn\'s sub-agent as running', () => {
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
