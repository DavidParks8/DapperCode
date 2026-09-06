import { EventType, type AGUIEvent } from '@ag-ui/core';
import { FlatList } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import { getMessageText } from '@bridge/messages';
import type { Chat, ChatMessage as Message } from '@bridge/types/types';
import { TestableThreadState } from '@shared/testing/TestableThreadState';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChatMessage } from '../message/ChatMessage';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';
import type { TranscriptDisplayItem } from './messages';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);

const date = '2026-09-05T00:00:00.000Z';
const theme = createAppTheme('dark');
const threadId = 'thread';
const runId = 'run-2';
const trees: ReactTestRenderer[] = [];

type Queryable = ReactTestInstance & {
  children: (Queryable | string)[];
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: typeof ChatMessage): Queryable[];
};

function message<Role extends 'user' | 'assistant' | 'reasoning' | 'system'>(
  id: string,
  role: Role,
  content: string,
) {
  return { id, role, content, createdAt: date };
}

const firstUser = message('u1', 'user', 'First prompt');
const firstAnswer = message('a1', 'assistant', 'First answer');
const first = [firstUser, firstAnswer];
const nextUser = message('u2', 'user', 'Second prompt');
const output = message('a2', 'assistant', 'Second answer');
const firstLabels = ['user:First prompt', 'assistant:First answer'];

function chat(messages: Message[], status: Chat['status'] = 'running'): Chat {
  return {
    id: threadId,
    title: 'Projection recovery',
    status,
    createdAt: date,
    updatedAt: date,
    statusUpdatedAt: date,
    lastMessagePreview: '',
    messages,
  };
}

const baseProps: ChatTranscriptViewProps = {
  chat: chat([]),
  parentChat: null,
  bridgeUrl: 'http://127.0.0.1',
  bridgeToken: null,
  showToolCalls: true,
  agentThreadStatusById: new Map(),
  scrollRef: { current: null },
  inlineChoicesEnabled: false,
  onInlineOptionSelect: jest.fn(),
  onPinnedAutoScroll: jest.fn(),
  onJumpToLatest: jest.fn(),
  onScrollInteractionStart: jest.fn(),
  autoScrollStateRef: {
    current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
  },
  bottomInset: 0,
  scrollRailEnabled: false,
};

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

function snapshot(messages: Message[]): TestableThreadState {
  const state = new TestableThreadState();
  apply(state, { type: EventType.MESSAGES_SNAPSHOT, messages }, 'run-1');
  return state;
}

function stream(
  state: TestableThreadState,
  value: Extract<Message, { role: 'user' | 'assistant' }>,
): void {
  apply(state, {
    type: EventType.TEXT_MESSAGE_CHUNK,
    messageId: value.id,
    role: value.role,
    delta: getMessageText(value),
  });
}

function element(stored: Chat, state: TestableThreadState) {
  return (
    <AppThemeProvider theme={theme}>
      <ChatTranscriptView
        {...baseProps}
        chat={stored}
        liveMessageState={state.getThreadState(threadId)}
      />
    </AppThemeProvider>
  );
}

function render(stored: Chat, state: TestableThreadState): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(element(stored, state));
  });
  if (!tree) {
    throw new Error('Expected a transcript tree');
  }
  trees.push(tree);
  return tree;
}

function update(tree: ReactTestRenderer, stored: Chat, state: TestableThreadState): void {
  const inputs = JSON.stringify({ stored, live: state.getThreadState(threadId) });
  act(() => tree.update(element(stored, state)));
  expect(JSON.stringify({ stored, live: state.getThreadState(threadId) })).toBe(inputs);
}

function expectRows(tree: ReactTestRenderer, expected: string[]): void {
  const root = tree.root as Queryable;
  const data = root.findByType(FlatList).props['data'] as readonly TranscriptDisplayItem[];
  const items = [...data].reverse();
  expect(
    items.map((item) =>
      item.kind === 'message'
        ? `${item.message.role}:${getMessageText(item.message)}`
        : item.kind === 'toolInvocation'
          ? `tool:${item.invocation.id}`
          : `group:${item.id}`,
    ),
  ).toEqual(expected);
  const renderedMessages = root.findAllByType(ChatMessage).map((node) => {
    const value = node.props['message'] as Message;
    return `${value.role}:${getMessageText(value)}`;
  });
  expect(renderedMessages.reverse()).toEqual(
    expected.filter((value) => !value.startsWith('tool:')),
  );
}

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) {
      tree.unmount();
    }
  });
});

describe('real transcript recovery during cache hydration', () => {
  it('retains a local system row between a snapshot prompt and its replaced draft', () => {
    const draft = message('draft', 'assistant', 'Draft');
    const corrected = message('corrected', 'assistant', 'Corrected');
    const local = message('local-system-1', 'system', 'Turn stopped by user.');
    const stored = chat([...first, nextUser, local, draft]);
    const state = snapshot([nextUser, draft]);
    const tree = render(stored, state);
    const before = [...firstLabels, 'user:Second prompt', 'system:Turn stopped by user.'];
    expectRows(tree, [...before, 'assistant:Draft']);
    apply(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: corrected.id,
      role: 'assistant',
      replacesMessageId: draft.id,
    });
    stream(state, corrected);
    update(tree, stored, state);
    expectRows(tree, [...before, 'assistant:Corrected']);
    update(tree, chat([...first, nextUser, local, corrected]), state);
    expectRows(tree, [...before, 'assistant:Corrected']);
  });

  it('replaces a post-snapshot draft in place before a later un-echoed prompt', () => {
    const draft = message('draft', 'assistant', 'Draft');
    const corrected = message('corrected', 'assistant', 'Corrected');
    const laterUser = message('u3', 'user', 'Third prompt');
    const state = snapshot(first);
    stream(state, nextUser);
    stream(state, draft);
    const stored = chat([...first, nextUser, draft, laterUser]);
    const tree = render(stored, state);
    const before = [...firstLabels, 'user:Second prompt'];
    expectRows(tree, [...before, 'assistant:Draft', 'user:Third prompt']);
    apply(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: corrected.id,
      role: 'assistant',
      replacesMessageId: draft.id,
    });
    stream(state, corrected);
    update(tree, stored, state);
    const expected = [...before, 'assistant:Corrected', 'user:Third prompt'];
    expectRows(tree, expected);
    update(tree, chat([...first, nextUser, corrected, laterUser]), state);
    expectRows(tree, expected);
  });

  it('does not duplicate re-IDed history with a trailing local system row', () => {
    const local = message('local-system-1', 'system', 'Turn stopped by user.');
    const state = snapshot(first);
    const tree = render(chat([...first, local], 'complete'), state);
    const expected = [...firstLabels, 'system:Turn stopped by user.'];
    expectRows(tree, expected);
    const history = first.map((value) => ({ ...value, id: `history-${value.id}` }));
    update(tree, chat([...history, local], 'complete'), state);
    expectRows(tree, expected);
    update(tree, chat([...history, local, nextUser]), state);
    expectRows(tree, [...expected, 'user:Second prompt']);
  });

  it('retains every unrelated row when the cache swaps a draft for its explicit replacement', () => {
    const draft = message('draft', 'assistant', 'Draft');
    const corrected = message('corrected', 'assistant', 'Corrected');
    const state = snapshot([draft]);
    apply(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: corrected.id,
      role: 'assistant',
      replacesMessageId: draft.id,
    });
    stream(state, corrected);
    const tree = render(chat([...first, nextUser, draft]), state);
    const expected = [...firstLabels, 'user:Second prompt', 'assistant:Corrected'];
    expectRows(tree, expected);
    update(tree, chat([...first, nextUser, corrected]), state);
    expectRows(tree, expected);
    const root = tree.root as Queryable;
    expect(root.findAll((node) => node.children.includes('Draft'))).toHaveLength(0);
    expect(root.findAll((node) => node.children.includes('Corrected')).length).toBeGreaterThan(0);
  });

  it('keeps earlier rows when the retained snapshot only contains a blank placeholder', () => {
    const state = snapshot([message('placeholder', 'assistant', '')]);
    const stored = chat([...first, nextUser]);
    const tree = render(stored, state);
    expectRows(tree, [...firstLabels, 'user:Second prompt']);
    stream(state, output);
    update(tree, stored, state);
    const expected = [...firstLabels, 'user:Second prompt', 'assistant:Second answer'];
    expectRows(tree, expected);
    update(tree, chat([...stored.messages, output]), state);
    expectRows(tree, expected);
  });

  it.each([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED] as const)(
    'does not visibly shorten the answer when %s settles the live stream',
    (terminal) => {
      const complete = message('a2', 'assistant', 'Second answer with all the details');
      const partial: Message = {
        ...output,
        pending: true,
        parts: [{ type: 'text', text: 'Second answer' }],
      };
      const state = snapshot(first);
      stream(state, nextUser);
      stream(state, complete);
      const stored = chat([...first, nextUser, partial]);
      const tree = render(stored, state);
      const expected = [...firstLabels, 'user:Second prompt', `assistant:${complete.content}`];
      expectRows(tree, expected);
      apply(
        state,
        terminal === EventType.TEXT_MESSAGE_END
          ? { type: terminal, messageId: complete.id }
          : { type: terminal, threadId, runId },
      );
      update(
        tree,
        { ...stored, status: terminal === EventType.RUN_FINISHED ? 'complete' : 'running' },
        state,
      );
      expectRows(tree, expected);
      const root = tree.root as Queryable;
      expect(
        root.findAll((node) => node.children.includes(getMessageText(complete))).length,
      ).toBeGreaterThan(0);
      const answer = root
        .findAllByType(ChatMessage)
        .find((node) => (node.props['message'] as Message).id === complete.id);
      expect(answer?.props['message']).toMatchObject({ pending: false, content: complete.content });
      update(tree, chat([...first, nextUser, complete], 'complete'), state);
      expectRows(tree, expected);
    },
  );

  it('keeps uncached commentary and a tool ahead of an already cached final answer', () => {
    const comment = message('comment', 'assistant', 'I will inspect the code first');
    const state = snapshot(first);
    stream(state, nextUser);
    stream(state, comment);
    apply(state, { type: EventType.TOOL_CALL_START, toolCallId: 'read', toolCallName: 'Read' });
    stream(state, output);
    const stored = chat([...first, nextUser]);
    const tree = render(stored, state);
    const expected = [
      ...firstLabels,
      'user:Second prompt',
      'assistant:I will inspect the code first',
      'tool:read',
      'assistant:Second answer',
    ];
    expectRows(tree, expected);
    update(tree, chat([...stored.messages, output]), state);
    expectRows(tree, expected);
    const read: Message = {
      id: 'persisted-read',
      role: 'tool',
      toolCallId: 'read',
      content: 'Read',
      createdAt: date,
      toolMeta: { toolCallId: 'read', title: 'Read', kind: 'read', status: 'in_progress' },
    };
    update(tree, chat([...stored.messages, comment, read, output]), state);
    expectRows(tree, expected);
    apply(state, { type: EventType.RUN_FINISHED, threadId, runId });
    update(tree, chat([...stored.messages, comment, read, output], 'complete'), state);
    expectRows(tree, expected);
  });

  it('does not render a replayed reasoning turn twice after all persisted IDs change', () => {
    const reasoning = message('reason', 'reasoning', 'Considering the first task');
    const history = [firstUser, reasoning, firstAnswer];
    const state = snapshot([...history, nextUser]);
    const tree = render(chat(history), state);
    const expected = [
      'user:First prompt',
      'reasoning:Considering the first task',
      'assistant:First answer',
      'user:Second prompt',
    ];
    expectRows(tree, expected);
    const rekeyed = history.map((value) => ({ ...value, id: `history-${value.id}` }));
    update(tree, chat(rekeyed), state);
    expectRows(tree, expected);
    stream(state, output);
    update(tree, chat([...rekeyed, nextUser]), state);
    expectRows(tree, [...expected, 'assistant:Second answer']);
    apply(state, { type: EventType.RUN_FINISHED, threadId, runId });
    update(tree, chat([...rekeyed, nextUser, output], 'complete'), state);
    expectRows(tree, [...expected, 'assistant:Second answer']);
  });
});
