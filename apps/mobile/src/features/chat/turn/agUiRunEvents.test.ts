import type { AgUiEventEnvelope } from '@bridge/agui/agUi';
import type { Chat } from '@bridge/types/types';
import { EventType } from '@ag-ui/core';
import { createTestStore } from '@shell/state/testing';
import { coalesceAgUiTextContentEvents, processAgUiRunEvents } from './agUiRunEvents';
import type { MainScreenWsEventRouterContext } from './wsEventRouter';

function textEvent(
  delta: string,
  options: Partial<Pick<AgUiEventEnvelope, 'threadId' | 'runId'>> & {
    messageId?: string;
  } = {},
): AgUiEventEnvelope {
  return {
    threadId: options.threadId ?? 'thread',
    runId: options.runId ?? 'run',
    event: {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: options.messageId ?? 'message',
      delta,
    },
  };
}

describe('coalesceAgUiTextContentEvents', () => {
  it('materializes consecutive deltas for one message once per render frame', () => {
    const coalesced = coalesceAgUiTextContentEvents([
      textEvent('One'),
      textEvent(' two'),
      textEvent(' three'),
      textEvent('Other', { messageId: 'other' }),
      textEvent(' thread', { threadId: 'child', messageId: 'other' }),
    ]);

    expect(coalesced).toHaveLength(3);
    expect(coalesced[0]?.event).toMatchObject({
      messageId: 'message',
      delta: 'One two three',
    });
    expect(coalesced[1]?.event).toMatchObject({ messageId: 'other', delta: 'Other' });
    expect(coalesced[2]).toMatchObject({ threadId: 'child' });
  });
});

describe('agent command metadata', () => {
  function receiveCommands(threadId: string, value: unknown, selectedChat: Chat): Chat | null {
    let next: Chat | null = selectedChat;
    const setSelectedChat = jest.fn((update: (previous: Chat | null) => Chat | null) => {
      next = update(next);
    });
    processAgUiRunEvents(
      { store: createTestStore(), setSelectedChat } as unknown as MainScreenWsEventRouterContext,
      {
        method: 'bridge/agui.event',
        params: {
          threadId,
          runId: `${threadId}::session`,
          event: { type: EventType.CUSTOM, name: 'dappercode.dev/commands', value },
        },
      },
      selectedChat.id,
    );
    return next;
  }

  const chat = { id: 'thread', acpCommands: [] } as unknown as Chat;

  it('replaces the open chat commands with parsed hints, dropping malformed ones', () => {
    const value = {
      commands: [
        { name: 'review', description: 'Review changes', hint: '[focus]' },
        { name: 'compact', description: 'Compact', hint: '' },
        { name: 'skill', description: 'Run a skill', hint: { text: 'bad' } },
        { description: 'Missing name' },
      ],
    };

    expect(receiveCommands('thread', value, chat)?.acpCommands).toEqual([
      { name: 'review', description: 'Review changes', hint: '[focus]' },
      { name: 'compact', description: 'Compact' },
      { name: 'skill', description: 'Run a skill' },
    ]);
  });

  it('leaves the open chat alone when another thread advertises commands', () => {
    const value = { commands: [{ name: 'review', description: 'Review changes' }] };

    expect(receiveCommands('other', value, chat)).toBe(chat);
  });
});
