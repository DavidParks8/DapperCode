import type { Chat } from '@bridge/types/types';
import { createTestStore } from '@shell/state/testing';
import { SLASH_COMMANDS, isSlashCommandAvailable } from '../helpers/helpers';
import { errorAtom } from '../state/turn';
import { executeSlashCommand } from './slashCommand';
import type { MainScreenSlashCommandHandlerContext } from './slashCommandHandler';

function run(input: string, acpCommands: Chat['acpCommands']) {
  const store = createTestStore();
  const startNewChat = jest.fn();
  const availability = {
    hasOpenChat: true,
    supportsGoal: false,
    supportsPlanMode: false,
    supportsReview: false,
  };
  const context = {
    ...availability,
    selectedChatId: 'thread',
    selectedChat: { id: 'thread', acpCommands } as Chat,
    activeAgentId: 'agent',
    activeAgentLabel: 'Agent',
    activeSlashCommands: SLASH_COMMANDS.filter((command) =>
      isSlashCommandAvailable(command, availability),
    ),
    startNewChat,
    store,
  } as unknown as MainScreenSlashCommandHandlerContext;
  return {
    handled: executeSlashCommand(context, input),
    error: () => store.get(errorAtom),
    startNewChat,
  };
}

describe('executeSlashCommand with agent-advertised commands', () => {
  it('passes commands only the agent knows through as prompt text', async () => {
    const result = run('/review-pr 42', [{ name: 'review-pr', description: 'Review a PR' }]);

    await expect(result.handled).resolves.toBe(false);
    expect(result.error()).toBeNull();
  });

  it('lets the agent run commands whose built-in is unavailable in this chat', async () => {
    const commands = [
      { name: 'review', description: 'Review changes', hint: '[focus]' },
      { name: 'init', description: 'Create AGENTS.md' },
    ];
    for (const input of ['/review src/app', '/INIT']) {
      const result = run(input, commands);

      await expect(result.handled).resolves.toBe(false);
      expect(result.error()).toBeNull();
    }
  });

  it('keeps rejecting unavailable built-ins the agent does not advertise', async () => {
    const review = run('/review src/app', []);
    await expect(review.handled).resolves.toBe(true);
    expect(review.error()).toBe('/review is not supported for Agent chats.');

    const init = run('/init', [{ name: 'review', description: 'Review changes' }]);
    await expect(init.handled).resolves.toBe(true);
    expect(init.error()).toBe('Available in the desktop CLI only right now.');
  });

  it('runs an available built-in even when the agent advertises the same name', async () => {
    const result = run('/new', [{ name: 'new', description: 'Agent new' }]);

    await expect(result.handled).resolves.toBe(true);
    expect(result.startNewChat).toHaveBeenCalledWith('agent');
  });
});
