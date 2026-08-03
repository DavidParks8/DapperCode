import type { Chat } from '@bridge/types/types';
import {
  applyPendingAcceptedTurn,
  registerAcceptedTurn,
  resolveAcceptedTurnChat,
} from './acceptedTurnState';
import { createSentMessageState, type StartedTurnResultArgs } from './sendMessageState';

function chat(id: string, status: Chat['status'] = 'complete'): Chat {
  return {
    id,
    title: id,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    lastMessagePreview: '',
    cwd: '/workspace',
    agentId: 'codex',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: 'Earlier prompt',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('accepted send state', () => {
  it('promotes a queued placeholder without switching chats or changing its original ordinal', () => {
    const targetChat = chat('target');
    const otherChat = chat('other');
    const selectedChatRef = { current: targetChat };
    const selectedChatIdRef = { current: targetChat.id as string | null };
    const queueOptimisticUserMessage = jest.fn();
    const scrollToBottomReliable = jest.fn();
    let selectedChat: Chat | null = targetChat;
    const state = createSentMessageState({
      targetChatId: targetChat.id,
      content: 'New prompt',
      turnMentions: [],
      turnLocalImages: [],
      optimisticQueuedMessage: { id: 'queued-placeholder' },
      queueOptimisticUserMessage,
      discardOptimisticUserMessage: jest.fn(),
      setSelectedChat: (update) => {
        selectedChat = typeof update === 'function' ? update(selectedChat) : update;
      },
      selectedChatIdRef,
      selectedChatState: targetChat,
      selectedChatRef,
      scrollToBottomReliable,
    });

    selectedChat = otherChat;
    selectedChatRef.current = otherChat;
    selectedChatIdRef.current = otherChat.id;
    state.promoteQueuedToSentMessage();

    expect(selectedChat).toBe(otherChat);
    expect(selectedChatRef.current).toBe(otherChat);
    expect(queueOptimisticUserMessage).toHaveBeenCalledWith(
      targetChat.id,
      expect.objectContaining({ content: 'New prompt' }),
      { userOrdinal: 2 },
    );
    expect(scrollToBottomReliable).not.toHaveBeenCalled();
  });

  it('interrupts the latest turn when an accepted send has no turn id', () => {
    const targetChat = chat('target', 'running');
    const stopRequestedRef = { current: true };
    const interruptLatestTurn = jest.fn().mockResolvedValue('resolved-turn');
    const args = {
      result: { turnId: null, chat: null },
      targetChatId: targetChat.id,
      selectedChatRef: { current: targetChat },
      registerTurnStarted: jest.fn(),
      interruptLatestTurn,
      setActiveTurnId: jest.fn(),
      setStoppingTurn: jest.fn(),
      stopRequestedRef,
    } as unknown as StartedTurnResultArgs;

    registerAcceptedTurn(args, true);

    expect(args.setActiveTurnId).toHaveBeenCalledWith(null);
    expect(interruptLatestTurn).toHaveBeenCalledWith(targetChat.id);
    expect(args.setStoppingTurn).not.toHaveBeenCalled();
    expect(stopRequestedRef.current).toBe(true);
  });

  it('does not resurrect a turn that settled before hydration completed', () => {
    const targetChat = chat('target', 'complete');
    const args = {
      result: { turnId: 'turn-complete', chat: null },
      targetChatId: targetChat.id,
      selectedChatRef: { current: targetChat },
      registerTurnStarted: jest.fn(),
      interruptLatestTurn: jest.fn(),
      setActiveTurnId: jest.fn(),
      setStoppingTurn: jest.fn(),
      stopRequestedRef: { current: false },
      mergeChatWithPendingOptimisticMessages: jest.fn((value: Chat) => value),
      setSelectedChat: jest.fn(),
      setShowDelayedGenericRunningActivity: jest.fn(),
      setActivity: jest.fn(),
      bumpRunWatchdog: jest.fn(),
    } as unknown as StartedTurnResultArgs;

    registerAcceptedTurn(args, true);
    expect(applyPendingAcceptedTurn(args, targetChat)).toBe(true);

    expect(args.registerTurnStarted).not.toHaveBeenCalled();
    expect(args.setSelectedChat).not.toHaveBeenCalled();
    expect(args.setActivity).not.toHaveBeenCalled();
    expect(args.bumpRunWatchdog).not.toHaveBeenCalled();

    const staleHydratedArgs = {
      ...args,
      result: { turnId: 'turn-complete', chat: chat('target', 'running') },
    } as StartedTurnResultArgs;
    expect(resolveAcceptedTurnChat(staleHydratedArgs, targetChat)).toBe(targetChat);
  });
});
