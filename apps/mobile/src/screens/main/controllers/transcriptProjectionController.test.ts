import type { Chat } from '../../../api/types';
import { createAgUiThreadMessageState } from '../../../api/agUiMessages';
import { createActivityMessage, SUBAGENT_ACTIVITY_TYPE } from '../../../api/messages';
import { projectTranscript } from './transcriptProjectionController';

const chat: Chat = {
  id: 'child',
  title: 'Child',
  status: 'running',
  createdAt: '',
  updatedAt: '',
  statusUpdatedAt: '',
  lastMessagePreview: '',
  parentThreadId: 'parent',
  messages: [{ id: 'u', role: 'user', content: 'child prompt', createdAt: '' }],
};

function liveState(
  messages: Chat['messages'],
  options: { terminal?: string[]; replacements?: Record<string, string> } = {},
) {
  return {
    ...createAgUiThreadMessageState(),
    messages,
    terminalMessageIds: options.terminal ?? [],
    replacesMessageIdByMessageId: options.replacements ?? {},
  };
}

describe('transcriptProjectionController', () => {
  it('projects inherited messages and a non-duplicate live assistant message', () => {
    const parent = {
      ...chat,
      id: 'parent',
      parentThreadId: undefined,
      messages: [{ id: 'p', role: 'user' as const, content: 'parent prompt', createdAt: '' }],
    };
    const projection = projectTranscript({
      chat,
      parentChat: parent,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'live', role: 'assistant', content: 'live answer', createdAt: 'now' },
      ]),
      now: () => 'now',
    });
    expect(projection.messages.at(-1)).toMatchObject({
      id: 'live',
      content: 'live answer',
      createdAt: 'now',
    });
    expect(projection.items).toHaveLength(projection.messages.length);
  });

  it('uses only child messages when no parent is available', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: false,
      threadStatuses: new Map(),
    });
    expect(projection.messages.map((message) => message.id)).toEqual(['u']);
    expect(projection.hiddenInheritedMessageCount).toBe(0);
  });

  it('renders live reasoning and tool projection entries', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'reasoning', role: 'reasoning', content: 'Thinking', createdAt: 'now' },
        {
          id: 'tool-result:read',
          role: 'tool',
          toolCallId: 'read',
          content: 'Read file\ndone',
          createdAt: 'now',
        },
      ]),
    });
    expect(projection.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'reasoning', role: 'reasoning' }),
        expect.objectContaining({ id: 'tool-result:read', role: 'tool', toolCallId: 'read' }),
      ]),
    );
  });

  it('preserves live subagent metadata for the transcript card', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: false,
      threadStatuses: new Map([['child-thread', 'running']]),
      liveMessageState: liveState([
        createActivityMessage(
          'subagent:task-1',
          SUBAGENT_ACTIVITY_TYPE,
          {
            text: '• Spawning sub-agent\n  Thread: child-thread\n  Status: running',
            subAgent: {
              tool: 'spawnAgent',
              senderThreadId: chat.id,
              receiverThreadIds: ['child-thread'],
              agentStatus: 'running',
            },
          },
          'now',
        ),
      ]),
    });

    expect(projection.messages.at(-1)).toMatchObject({
      role: 'activity',
      activityType: SUBAGENT_ACTIVITY_TYPE,
    });
  });

  it('does not append blank or duplicate live assistant text', () => {
    const withAssistant = {
      ...chat,
      parentThreadId: undefined,
      messages: [
        ...chat.messages,
        { id: 'a', role: 'assistant' as const, content: 'answer', createdAt: '' },
      ],
    };
    for (const liveMessage of [
      { id: 'live', role: 'assistant' as const, content: '  ', createdAt: 'now' },
      { id: 'a', role: 'assistant' as const, content: 'answer', createdAt: 'now' },
    ]) {
      expect(
        projectTranscript({
          chat: withAssistant,
          parentChat: null,
          showToolCalls: true,
          threadStatuses: new Map(),
          liveMessageState: liveState([liveMessage]),
        }).messages,
      ).toHaveLength(2);
    }
  });

  it('carries live reasoning state through a matching persisted snapshot message', () => {
    const persistedReasoning: Chat['messages'][number] = {
      id: 'reasoning',
      role: 'reasoning',
      content: 'Inspecting the active transcript',
      createdAt: 'persisted',
    };
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [persistedReasoning],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { ...persistedReasoning, createdAt: 'live', pending: true },
      ]),
    });

    expect(projection.messages).toEqual([
      expect.objectContaining({ id: 'reasoning', pending: true }),
    ]);
  });

  it('collapses optimistic, live, and persisted copies across user and reasoning rows', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          { id: 'server-user', role: 'user', content: 'test', createdAt: 'server' },
          { id: 'msg-local', role: 'user', content: 'test', createdAt: 'local' },
          {
            id: 'reasoning-1',
            role: 'reasoning',
            content: 'Got it. Ready when you are.',
            createdAt: 'server',
          },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState(
        [
          { id: 'server-user', content: 'test', role: 'user', createdAt: 'live' },
          {
            id: 'reasoning-1',
            content: 'Got it. Ready when you are.',
            role: 'reasoning',
            createdAt: 'live',
          },
        ],
        { terminal: ['reasoning-1'] },
      ),
    });

    expect(projection.messages.filter((message) => message.role === 'user')).toEqual([
      expect.objectContaining({ id: 'server-user', content: 'test' }),
    ]);
    expect(projection.messages.filter((message) => message.role === 'reasoning')).toEqual([
      expect.objectContaining({ id: 'reasoning-1', content: 'Got it. Ready when you are.' }),
    ]);
  });

  it('preserves repeated identical user prompts from distinct turns', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          { id: 'user-1', role: 'user', content: 'continue', createdAt: 'one' },
          { id: 'answer-1', role: 'assistant', content: 'First response', createdAt: 'two' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'user-2', role: 'user', content: 'continue', createdAt: 'three' },
      ]),
    });

    expect(projection.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(projection.messages.at(-1)).toMatchObject({ id: 'user-2', content: 'continue' });
  });

  it('uses authoritative snapshot order when persistence is partial', () => {
    const snapshot = liveState([
      { id: 'user', role: 'user', content: 'Question', createdAt: 'one' },
      { id: 'reason', role: 'reasoning', content: 'Thinking', createdAt: 'two' },
      { id: 'answer', role: 'assistant', content: 'Answer', createdAt: 'three' },
    ]);
    snapshot.authoritativeSnapshot = true;
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [{ id: 'answer', role: 'assistant', content: 'Answer', createdAt: 'persisted' }],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: snapshot,
    });

    expect(projection.messages.map((message) => message.id)).toEqual(['user', 'reason', 'answer']);
    expect(projection.messages.at(-1)?.createdAt).toBe('persisted');
  });

  it('does not restore inherited parent messages from a live sub-agent snapshot', () => {
    const parentMessages: Chat['messages'] = [
      { id: 'parent-user', role: 'user', content: 'Parent question', createdAt: 'one' },
      {
        id: 'parent-answer',
        role: 'assistant',
        content: 'Parent answer',
        createdAt: 'two',
      },
      createActivityMessage(
        'spawn-child',
        SUBAGENT_ACTIVITY_TYPE,
        {
          text: '• Spawned sub-agent',
          subAgent: {
            tool: 'spawn_agent',
            prompt: 'Inspect the mobile transcript',
            receiverThreadIds: ['child'],
          },
        },
        'three',
      ),
    ];
    const childMessages: Chat['messages'] = [
      {
        id: 'child-user',
        role: 'user',
        content: 'Inspect the mobile transcript',
        createdAt: 'four',
      },
      {
        id: 'child-answer',
        role: 'assistant',
        content: 'Found the projection bug',
        createdAt: 'five',
      },
    ];
    const snapshot = liveState([...parentMessages.slice(0, 2), ...childMessages]);
    snapshot.authoritativeSnapshot = true;

    const projection = projectTranscript({
      chat: { ...chat, messages: childMessages },
      parentChat: {
        ...chat,
        id: 'parent',
        parentThreadId: undefined,
        messages: parentMessages,
      },
      showToolCalls: false,
      threadStatuses: new Map(),
      liveMessageState: snapshot,
    });

    expect(projection.messages.map((message) => message.id)).toEqual([
      'child-user',
      'child-answer',
    ]);
  });

  it('preserves resumed history before the first message shared with a current-run snapshot', () => {
    const snapshot = liveState([
      { id: 'current-user', role: 'user', content: 'Follow up', createdAt: 'three' },
      { id: 'current-reasoning', role: 'reasoning', content: 'Thinking', createdAt: 'four' },
      { id: 'current-answer', role: 'assistant', content: 'Answer', createdAt: 'five' },
    ]);
    snapshot.authoritativeSnapshot = true;

    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          { id: 'earlier-user', role: 'user', content: 'Earlier question', createdAt: 'one' },
          {
            id: 'earlier-answer',
            role: 'assistant',
            content: 'Earlier answer',
            createdAt: 'two',
          },
          { id: 'current-user', role: 'user', content: 'Follow up', createdAt: 'three' },
          {
            id: 'current-reasoning',
            role: 'reasoning',
            content: 'Thinking',
            createdAt: 'four',
          },
          { id: 'current-answer', role: 'assistant', content: 'Answer', createdAt: 'five' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: snapshot,
    });

    expect(projection.messages.map((message) => message.id)).toEqual([
      'earlier-user',
      'earlier-answer',
      'current-user',
      'current-reasoning',
      'current-answer',
    ]);
  });

  it('replaces changing live text and suppresses it after persistence catches up', () => {
    const first = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'live', role: 'assistant', content: 'Hello', createdAt: 'live' },
      ]),
    });
    const second = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'live', role: 'assistant', content: 'Hello there', createdAt: 'live' },
      ]),
    });
    expect(first.messages.at(-1)?.content).toBe('Hello');
    expect(second.messages.at(-1)?.content).toBe('Hello there');
    expect(second.messages).toHaveLength(first.messages.length);

    const persisted = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'live', role: 'assistant', content: 'Hello there', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'live', role: 'assistant', content: 'Hello there', createdAt: 'live' },
      ]),
    });
    expect(persisted.messages.at(-1)?.id).toBe('live');
  });

  it('updates a matching persisted assistant message instead of appending a duplicate', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'assistant-1', role: 'assistant', content: 'Hello', createdAt: 'before' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        {
          id: 'agent-alpha:run::item::assistant-1',
          role: 'assistant',
          content: 'Hello there',
          createdAt: 'live',
          parts: [
            { type: 'text', text: 'Hello ' },
            { type: 'image', url: 'https://example.test/image.png' },
            { type: 'text', text: 'there' },
          ],
        },
      ]),
    });

    expect(projection.messages).toHaveLength(2);
    expect(projection.messages.at(-1)).toMatchObject({
      id: 'assistant-1',
      content: 'Hello there',
      createdAt: 'before',
      parts: [
        { type: 'text', text: 'Hello ' },
        { type: 'image', url: 'https://example.test/image.png' },
        { type: 'text', text: 'there' },
      ],
    });
  });

  it('does not regress a newer persisted message with stale live text', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'assistant-1', role: 'assistant', content: 'Hello there', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        {
          id: 'run-1::item::assistant-1',
          role: 'assistant',
          content: 'Hello',
          createdAt: 'live',
        },
      ]),
    });

    expect(projection.messages.at(-1)?.content).toBe('Hello there');
  });

  it('suppresses only an explicitly replaced live message', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'final', role: 'assistant', content: 'Corrected', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState(
        [
          { id: 'streamed', role: 'assistant', content: 'Stale', createdAt: 'live' },
          {
            id: 'final',
            role: 'assistant',
            content: 'Corrected',
            createdAt: 'live',
          },
        ],
        { replacements: { final: 'streamed' } },
      ),
    });

    expect(projection.messages.map((message) => message.content)).toEqual([
      'child prompt',
      'Corrected',
    ]);
  });

  it('projects multiple live assistant messages from one run in order', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState([
        { id: 'first', role: 'assistant', content: 'First', createdAt: 'live' },
        { id: 'second', role: 'assistant', content: 'Second', createdAt: 'live' },
      ]),
    });

    expect(projection.messages.map((message) => message.content)).toEqual([
      'child prompt',
      'First',
      'Second',
    ]);
  });

  it('lets a terminal persisted snapshot override longer retained live text', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'answer', role: 'assistant', content: 'Final', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveMessageState: liveState(
        [
          {
            id: 'answer',
            role: 'assistant',
            content: 'Final stale suffix',
            createdAt: 'live',
          },
        ],
        { terminal: ['answer'] },
      ),
    });

    expect(projection.messages.at(-1)?.content).toBe('Final');
  });
});
