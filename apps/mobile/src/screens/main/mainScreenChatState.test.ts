import type { Chat } from '../../api/types';
import { modelOptionsFromAcpConfig, resolveEquivalentChat } from './mainScreenChatState';

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
});

describe('modelOptionsFromAcpConfig', () => {
  it('does not reinterpret the effective ACP model as the server default', () => {
    const options = modelOptionsFromAcpConfig([
      {
        id: 'model',
        category: 'model',
        value: 'provider/active',
        options: [
          { value: 'provider/active', name: 'Provider/Active' },
          { value: 'provider/other', name: 'Provider/Other' },
        ],
      },
    ]);

    expect(options.map((option) => option.isDefault)).toEqual([undefined, undefined]);
  });
});
