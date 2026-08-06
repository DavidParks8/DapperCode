import { requireTestValue } from '@shared/testing/requireTestValue';
import type { ChatMessage } from '@bridge/types/types';
import {
  COMPACTION_ACTIVITY_TYPE,
  createActivityMessage,
  SUBAGENT_ACTIVITY_TYPE,
} from '@bridge/messages';
import {
  buildTranscriptDisplayItems,
  forkBoundariesByActionMessageId,
  getVisibleTranscriptMessages,
  MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP,
  syncVisibleSubAgentStatuses,
  type TranscriptDisplayItem,
} from './messages';

describe('forkBoundariesByActionMessageId', () => {
  const settledConversation = [
    message('user-1', 'user', 'First request'),
    message('assistant-1', 'assistant', 'First response'),
    message('user-2', 'user', 'Second request'),
    message('assistant-2', 'assistant', 'Second response'),
    message('user-3', 'user', 'Third request'),
    message('assistant-3', 'assistant', 'Third response'),
  ];

  it('offers settled authoritative non-first requests', () => {
    expect([...forkBoundariesByActionMessageId(settledConversation, 'complete')]).toEqual([
      ['assistant-1', 'user-2'],
      ['assistant-2', 'user-3'],
    ]);
  });

  it('names every settled response, including the newest, when the bridge resolves responses', () => {
    expect([
      ...forkBoundariesByActionMessageId(settledConversation, 'complete', { fromResponse: true }),
    ]).toEqual([
      ['assistant-1', 'assistant-1'],
      ['assistant-2', 'assistant-2'],
      ['assistant-3', 'assistant-3'],
    ]);
  });

  it('names only the last settled response of a multi-response turn', () => {
    const messages = [
      message('user-1', 'user', 'First request'),
      message('assistant-1a', 'assistant', 'Partial response'),
      message('assistant-1b', 'assistant', 'Final response'),
    ];
    expect([
      ...forkBoundariesByActionMessageId(messages, 'complete', { fromResponse: true }),
    ]).toEqual([['assistant-1b', 'assistant-1b']]);
  });

  it('skips pending and locally minted responses the bridge has never seen', () => {
    const messages = [
      message('user-1', 'user', 'First request'),
      message('msg-optimistic', 'assistant', 'Optimistic response'),
      message('user-2', 'user', 'Second request'),
      { ...message('assistant-live', 'assistant', 'Streaming response'), pending: true },
    ];
    expect([
      ...forkBoundariesByActionMessageId(messages, 'complete', { fromResponse: true }),
    ]).toEqual([]);
  });

  it('suppresses every boundary while the conversation is running', () => {
    const messages = [
      ...settledConversation.slice(0, 4),
      message('msg-optimistic', 'user', 'Optimistic request'),
      { ...message('assistant-live', 'assistant', 'Streaming response'), pending: true },
    ];
    expect([...forkBoundariesByActionMessageId(messages, 'running')]).toEqual([]);
    expect([
      ...forkBoundariesByActionMessageId(messages, 'running', { fromResponse: true }),
    ]).toEqual([]);
  });
});

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extras?: {
    systemKind?: 'tool' | 'reasoning' | 'subAgent' | 'compaction';
    subAgentMeta?: Parameters<typeof createActivityMessage>[2]['subAgent'];
  } & Record<string, unknown>,
): ChatMessage {
  const createdAt = '2026-03-19T00:00:00.000Z';
  if (extras?.systemKind === 'tool') {
    return { id, role: 'tool', toolCallId: id, content, createdAt };
  }
  if (extras?.systemKind === 'reasoning') {
    return { id, role: 'reasoning', content, createdAt };
  }
  if (extras?.systemKind === 'subAgent') {
    return createActivityMessage(
      id,
      SUBAGENT_ACTIVITY_TYPE,
      {
        text: content,
        ...(extras.subAgentMeta ? { subAgent: extras.subAgentMeta } : {}),
      },
      createdAt,
    );
  }
  if (extras?.systemKind === 'compaction') {
    return createActivityMessage(id, COMPACTION_ACTIVITY_TYPE, { text: content }, createdAt);
  }
  return {
    id,
    role: role === 'activity' || role === 'reasoning' || role === 'tool' ? 'system' : role,
    content,
    createdAt,
  };
}

describe('getVisibleTranscriptMessages', () => {
  it('hides tool rows when detailed tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Investigate this bug'),
      message('t1', 'system', '• Ran `npm test`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Found the issue.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
    ]);
  });

  it('keeps sub-agent system rows visible when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Review this repository'),
      message('s1', 'system', '• Spawned sub-agent\n  Prompt: Review the mobile app', {
        systemKind: 'subAgent',
      }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      's1',
      'a1',
    ]);
  });

  it('keeps reasoning rows visible when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Explain what you are checking'),
      message('r1', 'system', '• Reasoning\n  └ Inspecting the workspace state', {
        systemKind: 'reasoning',
      }),
      message('a1', 'assistant', 'I found the issue.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'r1',
      'a1',
    ]);
  });

  it('keeps compaction rows visible when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Summarize this thread'),
      message('c1', 'system', '• Compacted conversation context', {
        systemKind: 'compaction',
      }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'c1',
      'a1',
    ]);
  });

  it('keeps every message in a consecutive assistant run', () => {
    const messages = [
      message('u1', 'user', 'Answer this'),
      message('a1', 'assistant', 'Working...'),
      message('a2', 'assistant', 'Final answer'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ]);
  });

  it('keeps consecutive assistant image messages visible', () => {
    const messages = [
      message('u1', 'user', 'Show me the QR'),
      message('a1', 'assistant', '[local image: /tmp/bridge-pairing-qr.png]'),
      message('a2', 'assistant', 'Above.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ]);
  });

  it('replaces stale sub-agent status lines with the latest thread status', () => {
    const messages = [
      message('s1', 'system', '• Spawned sub-agent\n  Thread: child\n  Status: running', {
        systemKind: 'subAgent',
        subAgentMeta: {
          receiverThreadIds: ['child'],
          agentStatus: 'running',
        },
      }),
    ];

    const synced = syncVisibleSubAgentStatuses(messages, new Map([['child', 'complete']]));

    const syncedMessage = synced[0];
    expect(syncedMessage?.role).toBe('activity');
    if (!syncedMessage || syncedMessage.role !== 'activity') {
      throw new Error('Expected synced sub-agent message to be an activity message.');
    }
    expect(syncedMessage.content.text).toContain('Status: complete');
    expect(syncedMessage.content.subAgent?.agentStatus).toBe('complete');
  });

  it('keeps a terminal sub-agent status when its thread goes back to idle', () => {
    const messages = [
      message('s1', 'system', '• Sub-agent completed\n  Status: completed', {
        systemKind: 'subAgent',
        subAgentMeta: {
          receiverThreadIds: ['child'],
          agentStatus: 'completed',
        },
      }),
    ];

    expect(syncVisibleSubAgentStatuses(messages, new Map([['child', 'idle']]))).toBe(messages);
  });

  it('hides internal protocol content and blank assistant messages', () => {
    const messages = [
      message('result', 'assistant', 'FINAL_TASK_RESULT_JSON {}'),
      message('cwd', 'user', 'Current working directory is: /repo'),
      message('worktree', 'system', 'You are operating in task worktree /tmp'),
      message('blank', 'assistant', '   '),
      message('visible', 'assistant', 'Visible'),
    ];
    expect(getVisibleTranscriptMessages(messages, true)).toEqual([messages[4]]);
  });

  it('returns the original list when no sub-agent status can change', () => {
    const plain = [message('a', 'assistant', 'Answer')];
    expect(syncVisibleSubAgentStatuses(plain, new Map())).toBe(plain);
    expect(syncVisibleSubAgentStatuses(plain, new Map([['child', 'running']]))).toBe(plain);
    const withoutMeta = [message('s', 'system', 'Spawned', { systemKind: 'subAgent' })];
    expect(syncVisibleSubAgentStatuses(withoutMeta, new Map([['child', 'running']]))).toBe(
      withoutMeta,
    );
  });

  it('appends missing status lines and preserves already-current messages', () => {
    const spawned = message('s', 'system', '• Spawned sub-agent', {
      systemKind: 'subAgent',
      subAgentMeta: { receiverThreadIds: ['missing', 'child'], agentStatus: 'idle' },
    });
    const synced = syncVisibleSubAgentStatuses(
      [message('a', 'assistant', 'before'), spawned],
      new Map([['child', 'running']]),
    );
    expect(synced).not.toBe([message('a', 'assistant', 'before'), spawned]);
    const syncedSpawned = synced[1];
    expect(syncedSpawned?.role).toBe('activity');
    if (!syncedSpawned || syncedSpawned.role !== 'activity') {
      throw new Error('Expected synced spawned message to be an activity message.');
    }
    expect(syncedSpawned.content.text).toBe('• Spawned sub-agent\n  Status: running');
    expect(
      syncVisibleSubAgentStatuses(
        [requireTestValue(synced[1], 'indexed test value')],
        new Map([['child', 'running']]),
      )[0],
    ).toBe(synced[1]);
    expect(syncVisibleSubAgentStatuses([spawned], new Map([['other', 'running']]))).toEqual([
      spawned,
    ]);
  });
});

function summarizeItems(
  items: TranscriptDisplayItem[],
): Array<{ kind: string; id: string; title?: string }> {
  return items.map((item) => {
    if (item.kind === 'message') {
      return { kind: item.kind, id: item.renderKey };
    }
    if (item.kind === 'toolInvocation') {
      return { kind: item.kind, id: item.id, title: item.invocation.title };
    }
    return { kind: item.kind, id: item.id };
  });
}

describe('buildTranscriptDisplayItems', () => {
  it('emits one row per tool invocation instead of a single group', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('t2', 'system', '• Ran `ls`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(summarizeItems(buildTranscriptDisplayItems(messages))).toEqual([
      { kind: 'message', id: 'user-1-Audit this' },
      { kind: 'toolInvocation', id: 't1', title: 'Ran `pwd`' },
      { kind: 'toolInvocation', id: 't2', title: 'Ran `ls`' },
      { kind: 'message', id: 'a1' },
    ]);
  });

  it('folds one tool call split by other content into a single row', () => {
    // Regression: two rows carried the same tool call id as their React key, so
    // the tool rendered twice and React reported duplicate children.
    const callId = 'call_01_v9wRdhhSk6HQ9ws94PUB9680';
    const messages: ChatMessage[] = [
      message('u1', 'user', 'Run the snippet'),
      {
        id: 'call-message',
        role: 'assistant',
        content: '',
        createdAt: '2026-03-19T00:00:00.000Z',
        toolCalls: [{ id: callId, type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      message('a1', 'assistant', 'Running it now.'),
      {
        id: 'result-message',
        role: 'tool',
        toolCallId: callId,
        content: '• Ran `node -e ...`\n  harness ok 42',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
    ];

    const items = buildTranscriptDisplayItems(messages);
    const keys = items.map((item) => (item.kind === 'message' ? item.renderKey : item.id));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['user-1-Run the snippet', callId, 'a1']);

    const invocation = requireTestValue(
      items.find((item) => item.kind === 'toolInvocation')?.invocation,
      'tool invocation',
    );
    expect(invocation.textLines.join('\n')).toContain('harness ok 42');
  });

  it('keeps a run of computer-use tools grouped into one trace', () => {
    const messages = [
      message('u1', 'user', 'Drive the app'),
      message('t1', 'system', '• Called tool `computeruse / screenshot`', { systemKind: 'tool' }),
      message('t2', 'system', '• Called tool `computeruse / click`\n  └ App: Safari', {
        systemKind: 'tool',
      }),
      message('a1', 'assistant', 'Done.'),
    ];

    const items = buildTranscriptDisplayItems(messages);

    expect(summarizeItems(items)).toEqual([
      { kind: 'message', id: 'user-1-Drive the app' },
      { kind: 'toolGroup', id: 'tool-group-t1-t2' },
      { kind: 'message', id: 'a1' },
    ]);
    const group = requireTestValue(items[1], 'indexed test value');
    if (group.kind !== 'toolGroup') {
      throw new Error('expected a tool group');
    }
    expect(group.invocations.map((invocation) => invocation.title)).toEqual([
      'Called tool `computeruse / screenshot`',
      'Called tool `computeruse / click`',
    ]);
  });

  it('splits a computer-use run apart once an unrelated tool joins it', () => {
    const messages = [
      message('t1', 'system', '• Called tool `computeruse / screenshot`', { systemKind: 'tool' }),
      message('t2', 'system', '• Ran `ls`', { systemKind: 'tool' }),
    ];

    expect(summarizeItems(buildTranscriptDisplayItems(messages))).toEqual([
      { kind: 'toolInvocation', id: 't1', title: 'Called tool `computeruse / screenshot`' },
      { kind: 'toolInvocation', id: 't2', title: 'Ran `ls`' },
    ]);
  });

  it('drops a buffered tool message that carries no invocation at all', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      {
        id: 't1',
        role: 'tool',
        toolCallId: 't1',
        content: '',
        createdAt: '2026-03-19T00:00:00.000Z',
      } as ChatMessage,
      message('a1', 'assistant', 'Done.'),
    ];

    expect(summarizeItems(buildTranscriptDisplayItems(messages))).toEqual([
      { kind: 'message', id: 'user-1-Audit this' },
      { kind: 'message', id: 'a1' },
    ]);
  });

  it('keeps compaction rows separate from grouped tool activity', () => {
    const messages = [
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('c1', 'system', '• Compacted conversation context', {
        systemKind: 'compaction',
      }),
      message('t2', 'system', '• Ran `ls`', { systemKind: 'tool' }),
    ];

    expect(summarizeItems(buildTranscriptDisplayItems(messages))).toEqual([
      { kind: 'toolInvocation', id: 't1', title: 'Ran `pwd`' },
      { kind: 'message', id: 'c1' },
      { kind: 'toolInvocation', id: 't2', title: 'Ran `ls`' },
    ]);
  });

  it('keeps every invocation in a very long consecutive tool run', () => {
    const toolMessages = Array.from(
      { length: MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP + 3 },
      (_, index) =>
        message(`t${String(index)}`, 'system', `• Tool ${String(index)}`, { systemKind: 'tool' }),
    );

    const items = buildTranscriptDisplayItems(toolMessages);

    expect(items).toHaveLength(toolMessages.length);
    expect(items.every((item) => item.kind === 'toolInvocation')).toBe(true);
    expect(summarizeItems(items).at(-1)).toEqual({
      kind: 'toolInvocation',
      id: `t${String(toolMessages.length - 1)}`,
      title: `Tool ${String(toolMessages.length - 1)}`,
    });
  });

  it('renders a lone tool message as its own invocation row', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(summarizeItems(buildTranscriptDisplayItems(messages))).toEqual([
      { kind: 'message', id: 'user-1-Audit this' },
      { kind: 'toolInvocation', id: 't1', title: 'Ran `pwd`' },
      { kind: 'message', id: 'a1' },
    ]);
  });

  it('keeps user render keys stable when non-user rows are inserted later', () => {
    const baseMessages = [
      message('u1', 'user', 'First prompt'),
      message('a1', 'assistant', 'First answer'),
      message('u2', 'user', 'Second prompt'),
    ];
    const withToolMessage = [
      requireTestValue(baseMessages[0], 'first base message'),
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      ...baseMessages.slice(1),
    ];

    const isUserTranscriptItem = (
      item: TranscriptDisplayItem,
    ): item is Extract<TranscriptDisplayItem, { kind: 'message' }> =>
      item.kind === 'message' && item.message.role === 'user';

    const baseUserKeys = buildTranscriptDisplayItems(baseMessages)
      .filter(isUserTranscriptItem)
      .map((item) => item.renderKey);
    const insertedUserKeys = buildTranscriptDisplayItems(withToolMessage)
      .filter(isUserTranscriptItem)
      .map((item) => item.renderKey);

    expect(insertedUserKeys).toEqual(baseUserKeys);
  });

  it('does not group non-tool messages', () => {
    const messages = [
      message('assistant', 'assistant', '• Ran `pwd`'),
      message('typed', 'system', '• Ran `pwd`', { systemKind: 'reasoning' }),
      message('plain', 'system', 'Ran `pwd`'),
      message('empty', 'system', '\n '),
    ];
    expect(buildTranscriptDisplayItems(messages).every((item) => item.kind === 'message')).toBe(
      true,
    );
  });
});
