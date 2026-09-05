import type { RawAcpSnapshot } from '@bridge/mapping/chatMapping';
import type { Chat, ChatMessage, ChatSummary, ChatToolMeta } from '@bridge/types/types';
import {
  areChatsEquivalent,
  areChatStatusMapsEquivalent,
  areChatSummaryListsEquivalent,
} from './chatEquivalence';
import { resolveEquivalentChat } from './chatReconciliation';

const createdAt = '2026-07-25T00:00:00.000Z';

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'thread-equivalence',
    title: 'Equivalence thread',
    status: 'complete',
    createdAt,
    updatedAt: createdAt,
    statusUpdatedAt: createdAt,
    lastMessagePreview: 'Finished answer',
    messages: [
      {
        id: 'answer',
        role: 'assistant',
        content: 'Finished answer',
        createdAt,
      },
    ],
    ...overrides,
  };
}

function summary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'thread-equivalence',
    title: 'Equivalence thread',
    status: 'complete',
    createdAt,
    updatedAt: createdAt,
    statusUpdatedAt: createdAt,
    lastMessagePreview: 'Finished answer',
    ...overrides,
  };
}

function snapshot(): RawAcpSnapshot {
  return {
    version: 2,
    messages: [],
    tools: [],
    timeline: [],
    plan: [],
    usage: {},
    config: [],
    commands: [],
    session: { agentId: 'codex', threadId: 'thread-equivalence', historyReconstruction: false },
    active: { toolIds: [] },
    messageCollection: { truncated: true, omittedCount: 2, revision: 1, beforeCursor: 'before-1' },
    reasoningCollection: { truncated: false, omittedCount: 0, revision: 1 },
    toolCollection: { truncated: false, omittedCount: 0, revision: 1 },
    continuation: {
      revision: 1,
      unavailableCount: 0,
      maxPageSize: 100,
      maxHistoryEntries: 1000,
      maxHistoryBytes: 4096,
    },
  };
}

describe('areChatsEquivalent', () => {
  it('recognizes equivalent cloned chats', () => {
    const previous = chat();
    const next = chat({ messages: previous.messages.map((message) => ({ ...message })) });

    expect(areChatsEquivalent(previous, next)).toBe(true);
  });

  it('detects per-response usage changes', () => {
    const previous = chat();
    const next = chat({
      messages: [
        {
          ...previous.messages[0]!,
          usage: {
            inputTokens: 120,
            outputTokens: 48,
            reasoningTokens: 12,
            cachedReadTokens: 80,
            cachedWriteTokens: null,
            totalTokens: 260,
            model: 'gpt-5.4',
          },
        },
      ],
    });

    expect(areChatsEquivalent(previous, next)).toBe(false);
  });

  it('detects context and session usage changes', () => {
    const previous = chat();
    const next = chat({
      acpUsage: { used: 260, size: 4_096, cost: null },
      tokenTotals: {
        turns: 1,
        inputTokens: 120,
        outputTokens: 48,
        reasoningTokens: 12,
        cachedReadTokens: 80,
        cachedWriteTokens: null,
        totalTokens: 260,
      },
    });

    expect(areChatsEquivalent(previous, next)).toBe(false);
  });

  it.each<Partial<ChatToolMeta>>([
    { status: 'completed' },
    { status: 'failed' },
    { toolCallId: 'replacement-tool' },
    { kind: 'edit' },
    { title: 'Updated tool title' },
    { startedAtMs: 100 },
    { completedAtMs: 200 },
    { content: [{ type: 'diff', path: 'file.ts', oldText: 'old', newText: 'new' }] },
    { locations: [{ path: 'file.ts', line: 5 }] },
    { truncated: true },
  ])('detects tool metadata-only updates: %j', (update) => {
    const toolMeta: ChatToolMeta = {
      toolCallId: 'tool',
      kind: 'execute',
      status: 'in_progress',
      title: 'Run tests',
    };
    const previous = chat({
      messages: [
        { id: 'tool', role: 'tool', toolCallId: 'tool', content: '', createdAt, toolMeta },
      ],
    });
    const next = chat({
      messages: [{ ...previous.messages[0]!, toolMeta: { ...toolMeta, ...update } }],
    });

    expect(areChatsEquivalent(previous, next)).toBe(false);
    expect(resolveEquivalentChat(previous, next)).toBe(next);
  });

  it.each<ChatMessage>([
    {
      id: 'message',
      role: 'assistant',
      content: '',
      createdAt,
      toolCalls: [{ id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { id: 'message', role: 'assistant', content: '', createdAt, name: 'Agent' },
    { id: 'message', role: 'reasoning', content: '', createdAt, encryptedValue: 'new-reasoning' },
    { id: 'message', role: 'tool', toolCallId: 'tool', content: '', createdAt, error: 'Failed' },
    {
      id: 'message',
      role: 'user',
      content: '',
      createdAt,
      parts: [{ type: 'image', uri: 'file:///attachment.png' }],
    },
  ])('detects non-text message fields: %j', (nextMessage) => {
    const previousMessage = {
      ...nextMessage,
      parts: undefined,
      name: undefined,
      encryptedValue: undefined,
      toolCalls: undefined,
      error: undefined,
    };
    const previous = chat({ messages: [previousMessage] });
    const next = chat({ messages: [nextMessage] });

    expect(areChatsEquivalent(previous, next)).toBe(false);
  });

  it('detects tool-call identity and argument changes without message text changes', () => {
    const tool = {
      id: 'message',
      role: 'tool' as const,
      toolCallId: 'old',
      content: '',
      createdAt,
    };
    expect(
      areChatsEquivalent(
        chat({ messages: [tool] }),
        chat({ messages: [{ ...tool, toolCallId: 'new' }] }),
      ),
    ).toBe(false);
    const assistant: ChatMessage = {
      id: 'assistant',
      role: 'assistant',
      content: '',
      createdAt,
      toolCalls: [{ id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } }],
    };
    expect(
      areChatsEquivalent(
        chat({ messages: [assistant] }),
        chat({
          messages: [
            {
              ...assistant,
              toolCalls: [
                {
                  id: 'tool',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"a"}' },
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it.each<Partial<Chat>>([
    { activeTurnId: 'turn-new' },
    { acpActive: { runId: 'run', sourceTurnId: 'turn', generation: 2, toolIds: ['tool'] } },
    { acpMode: 'plan' },
    {
      acpConfig: [
        { id: 'model', value: 'new-model', options: [{ value: 'new-model', name: 'New' }] },
      ],
    },
    { acpCommands: [{ name: 'compact', description: 'Compact the conversation' }] },
    { timestampsSynthesized: true },
  ])('detects runtime and configuration updates: %j', (update) => {
    const previous = chat();
    const next = chat(update);
    expect(areChatsEquivalent(previous, next)).toBe(false);
    expect(resolveEquivalentChat(previous, next)).toBe(next);
  });

  it('accepts cleared active state and configuration without a summary change', () => {
    const previous = chat({
      activeTurnId: 'turn',
      acpActive: { runId: 'run', sourceTurnId: 'turn', generation: 1, toolIds: ['tool'] },
      acpMode: 'plan',
      acpConfig: [{ id: 'model', value: 'model' }],
      acpCommands: [{ name: 'compact', description: 'Compact' }],
    });
    const next = chat({
      activeTurnId: null,
      acpActive: null,
      acpMode: null,
      acpConfig: [],
      acpCommands: [],
    });

    expect(resolveEquivalentChat(previous, next)).toBe(next);
    expect(resolveEquivalentChat(next, { ...next })).toBe(next);
  });

  it('preserves ordered message parts rather than treating them as an unordered payload', () => {
    const message: ChatMessage = {
      id: 'message',
      role: 'assistant',
      content: 'same fallback text',
      createdAt,
      parts: [
        { type: 'text', text: 'first' },
        { type: 'image', uri: 'file:///attachment.png' },
      ],
    };
    expect(
      areChatsEquivalent(
        chat({ messages: [message] }),
        chat({ messages: [{ ...message, parts: [...message.parts!].reverse() }] }),
      ),
    ).toBe(false);
  });

  it.each([
    ['messageCollection', { revision: 2 }],
    ['messageCollection', { beforeCursor: 'before-2' }],
    ['reasoningCollection', { beforeCursor: 'reasoning-2' }],
    ['toolCollection', { revision: 2 }],
    ['continuation', { revision: 2 }],
    ['continuation', { unavailableCount: 1 }],
    ['session', { historyReconstruction: true }],
  ] as const)('retains snapshot-only %s updates: %j', (field, update) => {
    const acpSnapshot = snapshot();
    const previous = chat({ acpSnapshot });
    const next = chat({
      acpSnapshot: { ...acpSnapshot, [field]: { ...acpSnapshot[field], ...update } },
    });
    expect(areChatsEquivalent(previous, next)).toBe(false);
    expect(resolveEquivalentChat(previous, next).acpSnapshot).toBe(next.acpSnapshot);
  });

  it('keeps references for equal payloads, including reordered JSON object keys', () => {
    const previous = chat({
      acpSnapshot: snapshot(),
      acpMode: 'plan',
      acpActive: { runId: 'run', sourceTurnId: 'turn', generation: 1, toolIds: ['tool'] },
      acpConfig: [{ id: 'mode', value: 'plan', options: [{ value: 'plan', name: 'Plan' }] }],
      acpCommands: [{ name: 'compact', description: 'Compact' }],
      messages: [
        {
          id: 'tool',
          role: 'tool',
          toolCallId: 'tool',
          content: '',
          createdAt,
          parts: [{ type: 'resource', resource: { uri: 'file:///a', text: 'text' } }],
          toolMeta: {
            toolCallId: 'tool',
            kind: 'edit',
            status: 'completed',
            title: 'Edit',
            content: [{ type: 'diff', path: 'file.ts', oldText: 'old', newText: 'new' }],
          },
        },
      ],
    });
    const next = JSON.parse(
      JSON.stringify(previous, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as Chat;

    expect(next).toEqual(previous);
    expect(areChatsEquivalent(previous, next)).toBe(true);
    expect(resolveEquivalentChat(previous, next)).toBe(previous);
  });
});

describe('areChatStatusMapsEquivalent', () => {
  it('compares status entries independent of map identity', () => {
    const previous = new Map<string, Chat['status']>([
      ['thread-1', 'running'],
      ['thread-2', 'complete'],
    ]);

    expect(areChatStatusMapsEquivalent(previous, new Map(previous))).toBe(true);
    expect(
      areChatStatusMapsEquivalent(
        previous,
        new Map([
          ['thread-1', 'complete'],
          ['thread-2', 'complete'],
        ]),
      ),
    ).toBe(false);
    expect(areChatStatusMapsEquivalent(previous, new Map([['thread-1', 'running']]))).toBe(false);
  });
});

describe('areChatSummaryListsEquivalent', () => {
  it('compares summary ordering and fields', () => {
    const previous = [summary(), summary({ id: 'thread-2', title: 'Second thread' })];

    expect(
      areChatSummaryListsEquivalent(
        previous,
        previous.map((item) => ({ ...item })),
      ),
    ).toBe(true);
    expect(
      areChatSummaryListsEquivalent(previous, [
        summary(),
        summary({ id: 'thread-2', title: 'Renamed thread' }),
      ]),
    ).toBe(false);
    expect(areChatSummaryListsEquivalent(previous, previous.slice(0, 1))).toBe(false);
  });
});
