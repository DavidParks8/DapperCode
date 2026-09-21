import { EventType, type AGUIEvent } from '@ag-ui/core';

import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import { MAX_MESSAGES_PER_THREAD } from '@bridge/agui/agUiMessagesState';
import type { RawAcpSnapshot } from '@bridge/mapping/chatMapping';
import { getMessageText } from '@bridge/messages';
import type { Chat, ChatMessage } from '@bridge/types/types';
import { TestableThreadState } from '@shared/testing/TestableThreadState';
import type { TranscriptDisplayItem } from '../messages';

const date = '2026-09-05T00:00:00.000Z';
const threadId = 'thread';
const runId = 'run-2';

function message<Role extends 'user' | 'assistant' | 'reasoning'>(
  id: string,
  role: Role,
  content: string,
) {
  return { id, role, content, createdAt: date };
}

const firstUser = message('u1', 'user', 'First prompt');
const firstAnswer: ChatMessage = {
  ...message('a1', 'assistant', 'First answer'),
  completedAt: date,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: null,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    model: 'test-model',
  },
};
const first = [firstUser, firstAnswer];
const nextUser = message('u2', 'user', 'Second prompt');
const output = message('a2', 'assistant', 'Second answer');
const firstLabels = ['user:First prompt', 'assistant:First answer'];

function chat(messages: ChatMessage[], overrides: Partial<Chat> = {}): Chat {
  return {
    id: threadId,
    title: 'Projection recovery',
    status: 'running',
    createdAt: date,
    updatedAt: date,
    statusUpdatedAt: date,
    lastMessagePreview: '',
    messages,
    ...overrides,
  };
}

function apply(state: TestableThreadState, event: AGUIEvent, eventRunId = runId): void {
  const envelope = parseAgUiEventNotification({
    method: 'bridge/agui.event',
    params: { threadId, runId: eventRunId, event },
  });
  if (!envelope) {
    throw new Error(`Invalid recovery notification: ${event.type}`);
  }
  state.apply(envelope.threadId, envelope.runId, envelope.event);
}

function snapshot(messages: ChatMessage[]): TestableThreadState {
  const state = new TestableThreadState();
  apply(state, { type: EventType.MESSAGES_SNAPSHOT, messages }, 'run-1');
  return state;
}

function stream(
  state: TestableThreadState,
  value: Extract<ChatMessage, { role: 'user' | 'assistant' }>,
): void {
  apply(state, {
    type: EventType.TEXT_MESSAGE_CHUNK,
    messageId: value.id,
    role: value.role,
    delta: getMessageText(value),
  });
}

function finish(state: TestableThreadState): void {
  apply(state, { type: EventType.RUN_FINISHED, threadId, runId });
}

function tool(id: string, title = 'Read'): Extract<ChatMessage, { role: 'tool' }> {
  return {
    id: `tool:${id}`,
    role: 'tool',
    toolCallId: id,
    content: title,
    createdAt: date,
    toolMeta: { toolCallId: id, title, kind: 'read', status: 'in_progress' },
  };
}

function label(item: TranscriptDisplayItem): string {
  if (item.kind === 'message') {
    return `${item.message.role}:${getMessageText(item.message)}`;
  }
  return item.kind === 'toolInvocation' ? `tool:${item.invocation.id}` : `group:${item.id}`;
}

function expectTranscript(state: TestableThreadState, stored: Chat, expected: string[]) {
  const inputs = JSON.stringify({ stored, live: state.getThreadState(threadId) });
  state.setPersistedChat(stored);
  const projected = state.projectTranscript(threadId);
  expect(projected.items.map(label)).toEqual(expected);
  expect(projected.messages.filter(({ role }) => role === 'user')).toHaveLength(
    expected.filter((value) => value.startsWith('user:')).length,
  );
  expect(state.findDuplicateIds(threadId)).toEqual([]);
  expect(JSON.stringify({ stored, live: state.getThreadState(threadId) })).toBe(inputs);
  return projected.messages;
}

describe('snapshot recovery retains unrelated history', () => {
  it('retains history when hydration removes the only explicitly replaced snapshot ID', () => {
    const draft = message('draft', 'assistant', 'Draft');
    const corrected = message('corrected', 'assistant', 'Corrected');
    const state = snapshot([draft]);
    const before = chat([...first, nextUser, draft]);
    expectTranscript(state, before, [...firstLabels, 'user:Second prompt', 'assistant:Draft']);

    apply(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: corrected.id,
      role: 'assistant',
      replacesMessageId: draft.id,
    });
    stream(state, corrected);
    const expected = [...firstLabels, 'user:Second prompt', 'assistant:Corrected'];
    expectTranscript(state, before, expected);
    const hydrated = chat([...first, nextUser, corrected]);
    const projected = expectTranscript(state, hydrated, expected);
    expect(projected.map(({ id }) => id)).toEqual(['u1', 'a1', 'u2', 'corrected']);
    expect(projected[1]).toMatchObject(firstAnswer);
    expect(state.getThreadState(threadId)?.replacesMessageIdByMessageId).toEqual({
      corrected: 'draft',
    });
    expect(state.getThreadState(threadId)?.snapshotMessageIds).toEqual(['draft']);
    finish(state);
    expectTranscript(state, hydrated, expected);
  });

  it.each(['', ' \n '])(
    'does not treat a filtered blank member %j as an empty snapshot',
    (text) => {
      const state = snapshot([message('placeholder', 'assistant', text)]);
      const before = chat([...first, nextUser]);
      expectTranscript(state, before, [...firstLabels, 'user:Second prompt']);
      stream(state, output);
      const expected = [...firstLabels, 'user:Second prompt', 'assistant:Second answer'];
      expectTranscript(state, before, expected);
      expectTranscript(state, chat([...before.messages, output]), expected);
      expect(state.getThreadState(threadId)?.snapshotMessageIds).toEqual(['placeholder']);
    },
  );

  it('still clears history for a genuinely empty snapshot, then retains the next prompt', () => {
    const state = snapshot([]);
    expectTranscript(state, chat(first), []);
    stream(state, output);
    expectTranscript(state, chat([nextUser]), ['user:Second prompt', 'assistant:Second answer']);
    expect(state.getThreadState(threadId)?.snapshotMessageIds).toEqual([]);
  });
});

describe('completion preserves progress without overriding a newer authoritative read', () => {
  it.each([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED] as const)(
    'keeps full text and cached metadata across %s and subsequent hydration',
    (terminal) => {
      const complete = message('a2', 'assistant', 'Second answer with all the details');
      const partial: ChatMessage = {
        ...output,
        parts: [{ type: 'text', text: 'Second answer' }],
        createdAt: '2026-09-05T00:00:01.000Z',
        pending: true,
      };
      const state = snapshot(first);
      const stored = chat([...first, nextUser, partial]);
      stream(state, nextUser);
      stream(state, complete);
      const expected = [...firstLabels, 'user:Second prompt', `assistant:${complete.content}`];
      expectTranscript(state, stored, expected);
      apply(
        state,
        terminal === EventType.TEXT_MESSAGE_END
          ? { type: terminal, messageId: complete.id }
          : { type: terminal, threadId, runId },
      );
      const projected = expectTranscript(state, stored, expected);
      expect(projected.at(-1)).toMatchObject({
        content: complete.content,
        createdAt: partial.createdAt,
        pending: false,
      });
      expect(projected.at(-1)?.completedAt).toEqual(expect.any(String));
      expect(state.getThreadState(threadId)?.terminalMessageIds).toContain(complete.id);
      expectTranscript(
        state,
        chat([...first, nextUser, complete], { status: 'complete' }),
        expected,
      );
    },
  );

  it('keeps full reasoning parts and collapses pending reasoning when its message ends', () => {
    const reasoning = message('reason', 'reasoning', 'Thinking through the complete problem');
    const cached: ChatMessage = {
      ...reasoning,
      content: 'Thinking',
      parts: [{ type: 'text', text: 'Thinking' }],
      pending: true,
    };
    const state = snapshot(first);
    apply(state, {
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoning.id,
      role: 'reasoning',
    });
    apply(state, {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: reasoning.id,
      delta: getMessageText(reasoning),
    });
    const stored = chat([...first, cached]);
    const expected = [...firstLabels, `reasoning:${reasoning.content}`];
    expect(expectTranscript(state, stored, expected).at(-1)?.pending).toBe(true);
    apply(state, { type: EventType.REASONING_MESSAGE_END, messageId: reasoning.id });
    expect(expectTranscript(state, stored, expected).at(-1)?.pending).toBe(false);
  });

  it.each(['settled', 'active', 'reconstructing', 'recovery-error', 'missing-response'] as const)(
    'only lets a settled authoritative snapshot replace a longer terminal stream (%s)',
    (readState) => {
      const complete = message('a2', 'assistant', 'Second answer stale suffix');
      const state = snapshot(first);
      stream(state, nextUser);
      stream(state, complete);
      const stored = chat([...first, nextUser, output]);
      const liveExpected = [...firstLabels, 'user:Second prompt', `assistant:${complete.content}`];
      expectTranscript(state, stored, liveExpected);
      finish(state);
      expectTranscript(state, stored, liveExpected);

      const acpSnapshot: RawAcpSnapshot = {
        version: 2,
        messages:
          readState === 'missing-response'
            ? []
            : [
                {
                  id: output.id,
                  role: 'assistant',
                  parts: [{ type: 'text', text: getMessageText(output) }],
                  truncated: false,
                },
              ],
        tools: [],
        plan: [],
        usage: {},
        config: [],
        commands: [],
        session: {
          agentId: 'agent',
          threadId,
          historyReconstruction: readState === 'reconstructing',
        },
        active: { runId: readState === 'active' ? runId : null, toolIds: [] },
      };
      expectTranscript(
        state,
        chat(stored.messages, {
          status: readState === 'active' ? 'running' : 'complete',
          acpSnapshot,
          historyRecoveryError: readState === 'recovery-error' ? 'Read unavailable' : null,
        }),
        readState === 'settled'
          ? [...firstLabels, 'user:Second prompt', 'assistant:Second answer']
          : liveExpected,
      );
    },
  );
});

describe('partially cached current-run chronology', () => {
  it.each(
    Array.from({ length: 8 }, (_, mask) =>
      [false, true].map((receivedStart) => ({ mask, receivedStart })),
    ).flat(),
  )(
    'inserts missing rows in place for cache mask $mask, RUN_STARTED=$receivedStart',
    ({ mask, receivedStart }) => {
      const comment = message('comment', 'assistant', 'I will inspect the code first');
      const read = tool('read');
      const state = snapshot(first);
      const before = chat([...first, nextUser]);
      expectTranscript(state, before, [...firstLabels, 'user:Second prompt']);
      if (receivedStart) {
        apply(state, { type: EventType.RUN_STARTED, threadId, runId });
      }
      stream(state, nextUser);
      stream(state, comment);
      apply(state, { type: EventType.TOOL_CALL_START, toolCallId: 'read', toolCallName: 'Read' });
      stream(state, output);
      const expected = [
        ...firstLabels,
        'user:Second prompt',
        'assistant:I will inspect the code first',
        'tool:read',
        'assistant:Second answer',
      ];
      expectTranscript(state, before, expected);
      const partial = chat([
        ...before.messages,
        ...[comment, read, output].filter((_, index) => (mask & (1 << index)) !== 0),
      ]);
      expectTranscript(state, partial, expected);
      finish(state);
      expectTranscript(state, partial, expected);
      const projected = expectTranscript(
        state,
        chat([...before.messages, comment, read, output], { status: 'complete' }),
        expected,
      );
      expect(projected[1]).toMatchObject(firstAnswer);
      expect(partial.messages.find(({ id }) => id === read.id)?.toolMeta).toEqual(
        mask & 2 ? read.toolMeta : undefined,
      );
    },
  );
});

describe('reconstructed history and bounded live replay', () => {
  it('keeps repeated current-run responses when byte truncation omits their prompt', () => {
    const history = [
      firstUser,
      message('old-comment', 'assistant', 'Checking'),
      message('old-answer', 'assistant', 'Done'),
    ];
    const stored = chat([...history, nextUser], {
      acpSnapshot: {
        version: 2,
        messages: [...history, nextUser].map((value) => ({
          id: value.id,
          role: value.role === 'assistant' ? 'agent' : value.role,
          parts: [{ type: 'text', text: getMessageText(value) }],
          truncated: false,
        })),
        tools: [],
        plan: [],
        usage: {},
        config: [],
        commands: [],
        session: { agentId: 'agent', threadId, historyReconstruction: false },
        active: { runId, toolIds: [] },
      },
    });
    const state = snapshot(history);
    const before = [
      'user:First prompt',
      'assistant:Checking',
      'assistant:Done',
      'user:Second prompt',
    ];
    expectTranscript(state, stored, before);
    const replay = [
      message('current-comment', 'assistant', 'Checking'),
      message('current-answer', 'assistant', 'Done'),
    ];
    apply(state, { type: EventType.MESSAGES_SNAPSHOT, messages: replay });
    const expected = [...before, 'assistant:Checking', 'assistant:Done'];
    expect(expectTranscript(state, stored, expected).map(({ id }) => id)).toEqual([
      ...stored.messages.map(({ id }) => id),
      ...replay.map(({ id }) => id),
    ]);
    finish(state);
    expectTranscript(state, stored, expected);
    expectTranscript(
      state,
      chat([...stored.messages, ...replay], { status: 'complete' }),
      expected,
    );
  });

  it('matches an entire re-IDed reasoning turn before its uncached next prompt', () => {
    const reasoning = message('reason', 'reasoning', 'Considering the first task');
    const history = [firstUser, reasoning, firstAnswer];
    const state = snapshot([...history, nextUser]);
    const expected = [
      'user:First prompt',
      'reasoning:Considering the first task',
      'assistant:First answer',
      'user:Second prompt',
    ];
    expectTranscript(state, chat(history), expected);
    const rekeyed = history.map((value) => ({ ...value, id: `history-${value.id}` }));
    const projected = expectTranscript(state, chat(rekeyed), expected);
    expect(projected[2]).toMatchObject({
      content: firstAnswer.content,
      createdAt: firstAnswer.createdAt,
      usage: firstAnswer.usage,
    });
    finish(state);
    expectTranscript(state, chat([...rekeyed, nextUser], { status: 'complete' }), expected);
  });

  it('preserves local-only rows inside a re-IDed replay, before kickoff and after a tool arrives', () => {
    const local = [
      message('local-command-1', 'user', '/status'),
      message('local-assistant-1', 'assistant', 'Model status'),
    ];
    const history = [firstUser, ...local, firstAnswer, nextUser];
    const expected = [
      'user:First prompt',
      'user:/status',
      'assistant:Model status',
      'assistant:First answer',
      'user:Second prompt',
    ];
    const state = snapshot(first);
    expectTranscript(state, chat(history), expected);
    const rekeyed = history.map((value) =>
      first.some(({ id }) => id === value.id) ? { ...value, id: `history-${value.id}` } : value,
    );
    expectTranscript(state, chat(rekeyed), expected);
    apply(state, { type: EventType.TOOL_CALL_START, toolCallId: 'read', toolCallName: 'Read' });
    const projected = expectTranscript(state, chat(rekeyed), [...expected, 'tool:read']);
    expect(projected.slice(1, 3)).toEqual(local);
    finish(state);
    expectTranscript(state, chat(rekeyed), [...expected, 'tool:read']);
  });

  it.each([false, true])('does not collapse identical later turns (user echo=%s)', (echo) => {
    const state = snapshot(first);
    const rekeyed = first.map((value) => ({ ...value, id: `history-${value.id}` }));
    expectTranscript(state, chat(rekeyed), firstLabels);
    const repeatedUser = { ...firstUser, id: 'repeat-user' };
    const repeatedAnswer = { ...firstAnswer, id: 'repeat-answer' };
    const stored = chat([...rekeyed, repeatedUser]);
    if (echo) {
      stream(state, repeatedUser);
    }
    expectTranscript(state, stored, [...firstLabels, 'user:First prompt']);
    stream(state, repeatedAnswer);
    expectTranscript(state, stored, [...firstLabels, ...firstLabels]);
    finish(state);
    const hydrated = chat([...stored.messages, repeatedAnswer], { status: 'complete' });
    expectTranscript(state, hydrated, [...firstLabels, ...firstLabels]);
    apply(state, { type: EventType.MESSAGES_SNAPSHOT, messages: hydrated.messages });
    expectTranscript(state, hydrated, [...firstLabels, ...firstLabels]);
  });

  it.each(
    [0, 1, 2, 125, 126, 127, 128, 129, 256].flatMap((toolCount) =>
      [false, true].flatMap((rekeyed) =>
        [false, true].map((cachedTools) => ({ toolCount, rekeyed, cachedTools })),
      ),
    ),
  )(
    'retains chronology at buffer boundary $toolCount (rekeyed=$rekeyed, cached=$cachedTools)',
    ({ toolCount, rekeyed, cachedTools }) => {
      const state = snapshot(first);
      const history = rekeyed
        ? first.map((value) => ({ ...value, id: `history-${value.id}` }))
        : first;
      expectTranscript(state, chat([...history, nextUser]), [...firstLabels, 'user:Second prompt']);
      const tools = Array.from({ length: toolCount }, (_, index) =>
        tool(`read-${String(index)}`, `Read ${String(index)}`),
      );
      for (const value of tools) {
        apply(state, {
          type: EventType.TOOL_CALL_START,
          toolCallId: value.toolCallId,
          toolCallName: getMessageText(value),
        });
      }
      const stored = chat([...history, nextUser, ...(cachedTools ? tools : [])]);
      const visibleTools = cachedTools ? tools : tools.slice(-MAX_MESSAGES_PER_THREAD);
      const expected = [
        ...firstLabels,
        'user:Second prompt',
        ...visibleTools.map((value) => `tool:${value.toolCallId}`),
      ];
      expectTranscript(state, stored, expected);
      if (toolCount === 127) {
        expect(state.getThreadState(threadId)?.messages.some(({ id }) => id === firstUser.id)).toBe(
          false,
        );
        expect(
          state.getThreadState(threadId)?.messages.some(({ id }) => id === firstAnswer.id),
        ).toBe(true);
      }
      finish(state);
      expectTranscript(state, { ...stored, status: 'complete' }, expected);
      expect(state.getThreadState(threadId)?.snapshotMessageIds).toEqual(['u1', 'a1']);
    },
  );
});
