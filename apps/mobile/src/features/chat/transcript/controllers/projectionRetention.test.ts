import type { Chat } from '@bridge/types/types';
import { createAgUiThreadMessageState } from '@bridge/agui/agUiMessages';
import type { AgUiMessageState } from '@bridge/agui/agUiMessagesState';
import { updateAgUiLiveAssistantMessages } from '@bridge/agui/agUi';
import { EventType } from '@ag-ui/core';
import { getMessageText } from '@bridge/messages';
import { projectTranscript } from './projectionController';

const message = (id: string, role: 'user' | 'assistant', content: string) => ({
  id,
  role,
  content,
  createdAt: '',
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'retains repeated prompts after history changes IDs (repeated answer=%s, received user echo=%s)',
  (repeatAnswer, receivedUserEcho) => {
    const chat: Chat = {
      id: 'thread',
      title: 'Retention',
      status: 'running',
      createdAt: '',
      updatedAt: '',
      statusUpdatedAt: '',
      lastMessagePreview: '',
      messages: [
        message('history-user-1', 'user', 'Continue'),
        message('history-answer-1', 'assistant', 'First result'),
      ],
    };
    const live = {
      ...createAgUiThreadMessageState(),
      snapshotMessageIds: ['original-user-1', 'original-answer-1'],
      messages: [
        message('original-user-1', 'user', 'Continue'),
        message('original-answer-1', 'assistant', 'First result'),
      ],
      runByMessageId: {
        'original-user-1': 'run-1',
        'original-answer-1': 'run-1',
      },
    };
    let state: AgUiMessageState = { [chat.id]: live };
    const project = () =>
      projectTranscript({
        chat,
        parentChat: null,
        showToolCalls: true,
        threadStatuses: new Map(),
        liveMessageState: state[chat.id],
      }).messages;

    expect(project().map(getMessageText)).toEqual(['Continue', 'First result']);
    chat.messages.push(message('user-2', 'user', 'Continue'));
    if (receivedUserEcho) {
      state = updateAgUiLiveAssistantMessages(state, {
        threadId: chat.id,
        runId: 'run-2',
        event: {
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: 'user',
          messageId: 'user-2',
          delta: 'Continue',
        },
      });
      expect(project().map(getMessageText)).toEqual(['Continue', 'First result', 'Continue']);
    }
    const answer = repeatAnswer ? 'First result' : 'Second result';
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: chat.id,
      runId: 'run-2',
      event: {
        type: EventType.TEXT_MESSAGE_CHUNK,
        role: 'assistant',
        messageId: 'answer-2',
        delta: answer,
      },
    });
    chat.messages.push(message('answer-2', 'assistant', answer));
    expect(project().map(getMessageText)).toEqual(['Continue', 'First result', 'Continue', answer]);
    expect(project().filter(({ id }) => id === 'user-2')).toHaveLength(1);
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: chat.id,
      runId: 'run-2',
      event: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: chat.messages.filter(
          (entry) => entry.role === 'user' || entry.role === 'assistant',
        ),
      },
    });
    expect(project().map(getMessageText)).toEqual(['Continue', 'First result', 'Continue', answer]);
  },
);

it('preserves message counts and chronology across reconstructed transcript segments', () => {
  for (let turns = 1; turns <= 5; turns += 1) {
    for (let start = 0; start < turns; start += 1) {
      for (let end = start + 1; end <= turns; end += 1) {
        const messages = Array.from({ length: turns }, (_, turn) => [
          message(`user-${String(turn)}`, 'user', 'Continue'),
          message(`answer-${String(turn)}`, 'assistant', turn % 2 ? 'Done' : 'First result'),
        ]).flat();
        const chat: Chat = {
          id: 'thread',
          title: '',
          status: 'running',
          createdAt: '',
          updatedAt: '',
          statusUpdatedAt: '',
          lastMessagePreview: '',
          messages: [
            ...messages,
            message('latest-user', 'user', 'Continue'),
            message('latest-answer', 'assistant', 'Live result'),
          ],
        };
        const live = createAgUiThreadMessageState();
        live.messages = messages.slice(start * 2, end * 2).map((entry) => ({
          ...entry,
          id: `reconstructed-${entry.id}`,
        }));
        live.snapshotMessageIds = live.messages.map(({ id }) => id);
        live.runByMessageId = Object.fromEntries(live.messages.map(({ id }) => [id, 'old-run']));
        const newestAnswer = message('latest-answer', 'assistant', 'Live result');
        live.messages.push(newestAnswer);
        live.runByMessageId[newestAnswer.id] = 'new-run';
        const projected = projectTranscript({
          chat,
          parentChat: null,
          showToolCalls: true,
          threadStatuses: new Map(),
          liveMessageState: live,
        }).messages;
        expect(projected.map(getMessageText)).toEqual(chat.messages.map(getMessageText));
        expect(projected.filter(({ role }) => role === 'user')).toHaveLength(turns + 1);
      }
    }
  }
});

it('appends a new repeated turn rather than replacing an older interior turn', () => {
  const messages = [
    message('old-user', 'user', 'Continue'),
    message('old-answer', 'assistant', 'Done'),
    message('intervening-user', 'user', 'Different question'),
    message('intervening-answer', 'assistant', 'Later answer'),
  ];
  const chat: Chat = {
    id: 'thread',
    title: '',
    status: 'running',
    createdAt: '',
    updatedAt: '',
    statusUpdatedAt: '',
    lastMessagePreview: '',
    messages,
  };
  const live = createAgUiThreadMessageState();
  live.messages = [
    message('new-user', 'user', 'Continue'),
    message('new-answer', 'assistant', 'Done'),
  ];
  live.snapshotMessageIds = live.messages.map(({ id }) => id);
  live.runByMessageId = { 'new-user': 'new-run', 'new-answer': 'new-run' };
  expect(
    projectTranscript({
      chat,
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: live,
    }).messages.map(({ id }) => id),
  ).toEqual([
    'old-user',
    'old-answer',
    'intervening-user',
    'intervening-answer',
    'new-user',
    'new-answer',
  ]);
});

it('retains distinct tool results even when their text is identical', () => {
  const tools = (prefix: string): Chat['messages'] =>
    [0, 1].map((index) => ({
      id: `${prefix}-${String(index)}`,
      role: 'tool',
      toolCallId: `${prefix}-${String(index)}`,
      content: 'Done',
      createdAt: '',
    }));
  const chat: Chat = {
    id: 'thread',
    title: '',
    status: 'running',
    createdAt: '',
    updatedAt: '',
    statusUpdatedAt: '',
    lastMessagePreview: '',
    messages: tools('previous'),
  };
  const live = createAgUiThreadMessageState();
  live.messages = tools('current');
  live.snapshotMessageIds = live.messages.map(({ id }) => id);
  expect(
    projectTranscript({
      chat,
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: live,
    }).messages.map(({ id }) => id),
  ).toEqual(['previous-0', 'previous-1', 'current-0', 'current-1']);
});

it('does not treat a repeated prompt by itself as a reconstructed turn', () => {
  const chat: Chat = {
    id: 'thread',
    title: '',
    status: 'running',
    createdAt: '',
    updatedAt: '',
    statusUpdatedAt: '',
    lastMessagePreview: '',
    messages: [message('user-1', 'user', 'Continue'), message('answer-1', 'assistant', 'Done')],
  };
  const live = createAgUiThreadMessageState();
  live.messages = [message('user-2', 'user', 'Continue')];
  live.snapshotMessageIds = ['user-2'];
  expect(
    projectTranscript({
      chat,
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: live,
    }).messages.map(({ id }) => id),
  ).toEqual(['user-1', 'answer-1', 'user-2']);
});
