import type { Chat, ChatSummary } from '@bridge/types/types';
import {
  areChatsEquivalent,
  areChatStatusMapsEquivalent,
  areChatSummaryListsEquivalent,
} from './chatEquivalence';

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
