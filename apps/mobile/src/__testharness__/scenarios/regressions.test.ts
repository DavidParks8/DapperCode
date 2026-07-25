import { EventType } from '@ag-ui/core';
import { registerTestHarnessMatchers } from '../AssertionHelpers';
import { TestableThreadState } from '../TestableThreadState';
import { sequence } from '../EventSequenceBuilder';
import {
  nestedSubAgent,
  parentOnlySubAgent,
  spawnToolThenSubAgentCard,
  subAgentStatusOnlyUpdate,
  subAgentTerminalThenIdleThread,
  promptAfterSnapshot,
  streamThenAuthoritativeSnapshot,
  multiTurnReplayedHistory,
} from '../fixtures/regressions';

registerTestHarnessMatchers();

/**
 * Every scenario here reproduces a defect that reached a user. They are written
 * against the sequence of events the bridge actually emits, so a regression fails
 * here rather than on a device.
 */

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

  it('never renders the same message twice across a multi-turn session', () => {
    const state = new TestableThreadState();
    for (let turn = 1; turn <= 4; turn += 1) {
      const runId = `run-${String(turn)}`;
      state.applySequence(
        sequence('t1', runId)
          .runStarted()
          .textMessage(`answer ${String(turn)}`, { messageId: `t1::msg-${String(turn)}` })
          .runFinished()
          .build(),
      );
      state.setPersistedChat({
        ...state.buildSyntheticChat('t1'),
        messages: state.projectTranscript('t1').messages,
      });
    }

    expect(state.findDuplicateIds('t1')).toEqual([]);
    expect(state.findDuplicateContent('t1')).toEqual([]);
  });
});

describe('Sub-agent card lifecycle', () => {
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
