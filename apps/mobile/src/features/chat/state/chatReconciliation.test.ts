import type { Chat } from '@bridge/types/types';
import { resolveEquivalentChat } from './chatReconciliation';

const createdAt = '2026-07-25T00:00:00.000Z';

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'thread-status',
    title: 'Status thread',
    status: 'complete',
    createdAt,
    updatedAt: createdAt,
    statusUpdatedAt: createdAt,
    lastMessagePreview: 'Existing answer',
    cwd: '/workspace',
    agentId: 'codex',
    messages: [
      {
        id: 'answer',
        role: 'assistant',
        content: 'Existing answer',
        createdAt,
      },
    ],
    ...overrides,
  };
}

describe('resolveEquivalentChat local transcript reconciliation', () => {
  const localCommand = {
    id: 'local-command-1',
    role: 'user' as const,
    content: '/status',
    createdAt: '2026-07-25T00:00:01.000Z',
  };
  const localResponse = {
    id: 'local-assistant-1',
    role: 'assistant' as const,
    content: 'Model: codex\nChat status: running',
    createdAt: '2026-07-25T00:00:01.001Z',
  };

  it('keeps local command history across repeated sparse server snapshots', () => {
    const previous = chat({
      status: 'running',
      activeTurnId: 'turn-status',
      lastMessagePreview: localResponse.content,
      messages: [...chat().messages, localCommand, localResponse],
    });

    const next = chat({
      updatedAt: '2026-07-25T00:00:02.000Z',
      statusUpdatedAt: '2026-07-25T00:00:02.000Z',
      messages: [],
    });

    const first = resolveEquivalentChat(previous, next);
    const second = resolveEquivalentChat(first, next);

    expect(first).toEqual(
      expect.objectContaining({
        status: 'complete',
        updatedAt: next.updatedAt,
        messages: [chat().messages[0], localCommand, localResponse],
      }),
    );
    expect(second).toBe(first);
  });

  it('accepts server message progress without duplicating local entries', () => {
    const previous = chat({
      lastMessagePreview: localResponse.content,
      messages: [...chat().messages, localCommand, localResponse],
    });
    const refreshedAnswer: Chat['messages'][number] = {
      id: 'answer',
      role: 'assistant',
      content: 'Existing answer, refreshed',
      createdAt,
    };
    const newServerMessage: Chat['messages'][number] = {
      id: 'server-follow-up',
      role: 'assistant' as const,
      content: 'Server follow-up',
      createdAt: '2026-07-25T00:00:02.000Z',
    };

    const resolved = resolveEquivalentChat(
      previous,
      chat({
        lastMessagePreview: newServerMessage.content,
        messages: [refreshedAnswer, newServerMessage],
      }),
    );

    expect(resolved.messages).toEqual([
      refreshedAnswer,
      localCommand,
      localResponse,
      newServerMessage,
    ]);
    expect(
      resolveEquivalentChat(
        resolved,
        chat({
          lastMessagePreview: newServerMessage.content,
          messages: [refreshedAnswer, newServerMessage],
        }),
      ),
    ).toBe(resolved);
  });

  it('keeps hydrated history when a settled refresh is summary-only', () => {
    const previous = chat();
    const refreshed = chat({
      title: 'Refreshed title',
      updatedAt: '2026-07-25T00:00:02.000Z',
      lastMessagePreview: '',
      messages: [],
    });

    const resolved = resolveEquivalentChat(previous, refreshed);

    expect(resolved).toEqual(
      expect.objectContaining({
        title: 'Refreshed title',
        updatedAt: refreshed.updatedAt,
        lastMessagePreview: previous.lastMessagePreview,
        messages: previous.messages,
      }),
    );
  });

  it('applies usage-only updates from a settled turn snapshot', () => {
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

    const resolved = resolveEquivalentChat(previous, next);

    expect(resolved).toBe(next);
    expect(resolved.messages[0]?.usage?.totalTokens).toBe(260);
    expect(resolved.acpUsage?.used).toBe(260);
    expect(resolved.tokenTotals?.totalTokens).toBe(260);
  });

  it('merges a bounded terminal tail after the latest user turn instead of dropping its response', () => {
    const currentUser: Chat['messages'][number] = {
      id: 'current-user',
      role: 'user',
      content: 'Current question',
      createdAt: '2026-07-25T00:00:02.000Z',
    };
    const previous = chat({
      status: 'running',
      messages: [
        {
          id: 'older-user',
          role: 'user',
          content: 'Earlier question',
          createdAt,
        },
        {
          id: 'older-answer',
          role: 'assistant',
          content: 'Earlier answer',
          createdAt: '2026-07-25T00:00:01.000Z',
        },
        currentUser,
      ],
    });
    const finalResponse: Chat['messages'][number] = {
      id: 'final-response',
      role: 'assistant',
      content: 'Recovered final response',
      createdAt: '2026-07-25T00:00:03.000Z',
      usage: {
        inputTokens: 90,
        outputTokens: 30,
        reasoningTokens: null,
        cachedReadTokens: 40,
        cachedWriteTokens: null,
        totalTokens: 160,
        model: 'gpt-5.4',
      },
    };
    const next = chat({
      status: 'complete',
      lastMessagePreview: 'Recovered final response',
      messages: [currentUser, finalResponse],
    });

    const resolved = resolveEquivalentChat(previous, next);

    expect(resolved.messages.map(({ id }) => id)).toEqual([
      'older-user',
      'older-answer',
      'current-user',
      'final-response',
    ]);
    expect(resolved.messages.at(-1)).toEqual(finalResponse);
    expect(resolved.lastMessagePreview).toBe('Recovered final response');
  });

  it('keeps the unanswered local turn when a smaller snapshot predates it', () => {
    const previous = chat({
      status: 'running',
      lastMessagePreview: 'Current question',
      messages: [
        {
          id: 'older-user',
          role: 'user',
          content: 'Earlier question',
          createdAt,
        },
        {
          id: 'older-answer',
          role: 'assistant',
          content: 'Earlier answer',
          createdAt: '2026-07-25T00:00:01.000Z',
        },
        {
          id: 'current-user',
          role: 'user',
          content: 'Current question',
          createdAt: '2026-07-25T00:00:02.000Z',
        },
      ],
    });
    const stale = chat({
      status: 'running',
      lastMessagePreview: 'Earlier answer',
      messages: previous.messages.slice(0, 2),
    });

    const resolved = resolveEquivalentChat(previous, stale);

    expect(resolved.messages).toBe(previous.messages);
    expect(resolved.lastMessagePreview).toBe('Current question');
  });

  it('replaces local reasoning with the server reasoning message without duplication', () => {
    const reasoningContent = '• Reasoning\n  └ Checking constraints';
    const previous = chat({
      status: 'running',
      messages: [
        ...chat().messages,
        {
          id: 'local-reasoning-1',
          role: 'reasoning',
          content: reasoningContent,
          createdAt: '2026-07-25T00:00:01.000Z',
          pending: false,
        },
      ],
    });
    const serverReasoning: Chat['messages'][number] = {
      id: 'server-reasoning-1',
      role: 'reasoning',
      content: reasoningContent,
      createdAt: '2026-07-25T00:00:01.000Z',
    };

    const resolved = resolveEquivalentChat(
      previous,
      chat({ messages: [...chat().messages, serverReasoning] }),
    );

    expect(resolved.messages.filter((message) => message.role === 'reasoning')).toEqual([
      serverReasoning,
    ]);
  });
});
