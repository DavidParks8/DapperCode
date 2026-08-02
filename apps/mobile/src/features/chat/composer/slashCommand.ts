import { errorAtom } from '../state/turn';
import { selectedCollaborationModeAtom } from '../state/models';
import { screenSetter } from '../state/registry';
import { activityAtom } from '../state/composer';
import { executePlanCommand } from '../plan/command';
import {
  formatCollaborationModeLabel,
  parseSlashCommand,
  findSlashCommandDefinition,
  isSlashCommandAvailable,
} from '../helpers/helpers';
import type { MainScreenSlashCommandHandlerContext } from './slashCommandHandler';

export async function executeSlashCommand(
  context: MainScreenSlashCommandHandlerContext,
  input: string,
): Promise<boolean> {
  const {
    selectedChatId,
    supportsGoal,
    supportsPlanMode,
    supportsReview,
    activeAgentLabel,
    openAgentThreadSelectorRef,
    ensureLocalCommandChat,
    activeSlashCommands,
    appendLocalAssistantMessage,
    activeAgentId,
    startNewChat,
    preferredStartCwd,
    selectedChat,
    activeModelLabel,
    activeEffortLabel,
    supportsFastMode,
    fastModeEnabled,
    onOpenGit,
    store,
  } = context;
  const setError = screenSetter(store, errorAtom);
  const selectedCollaborationMode = store.get(selectedCollaborationModeAtom);
  const setActivity = screenSetter(store, activityAtom);

  const parsed = parseSlashCommand(input);
  if (!parsed) {
    return false;
  }

  const { name: rawName, args } = parsed;
  const commandDef = findSlashCommandDefinition(rawName);
  const name = commandDef?.name ?? rawName;
  const argText = args.trim();

  if (!commandDef) {
    return false;
  }

  if (!commandDef.mobileSupported) {
    setError(commandDef.availabilityNote ?? `/${name} is not supported on mobile.`);
    return true;
  }

  if (commandDef.requiresOpenChat && !selectedChatId) {
    setError(`/${name} requires an open chat`);
    return true;
  }

  if (
    !isSlashCommandAvailable(commandDef, {
      hasOpenChat: Boolean(selectedChatId),
      supportsGoal,
      supportsPlanMode,
      supportsReview,
    })
  ) {
    setError(`/${name} is not supported for ${activeAgentLabel} chats.`);
    return true;
  }

  const handlers: Partial<Record<string, () => Promise<boolean>>> = {
    agent: async () => {
      await openAgentThreadSelectorRef.current(argText || null);
      return true;
    },
    help: async () => {
      const commandChatId = await ensureLocalCommandChat(input);
      if (!commandChatId) {
        return true;
      }
      const lines = activeSlashCommands.map((command) => {
        const suffix = command.argsHint ? ` ${command.argsHint}` : '';
        const scope = command.mobileSupported ? 'mobile' : 'CLI only';
        return `/${command.name}${suffix} — ${command.summary} (${scope})`;
      });
      appendLocalAssistantMessage(`Supported slash commands:\n${lines.join('\n')}`, commandChatId);
      return true;
    },
    new: () => {
      if (activeAgentId) {
        startNewChat(activeAgentId);
      }
      return Promise.resolve(true);
    },
    model: () => {
      setError('This ACP agent does not advertise configurable models.');
      return Promise.resolve(true);
    },
    plan: () => executePlanCommand(context, argText),
    status: async () => {
      const commandChatId = await ensureLocalCommandChat(input);
      if (!commandChatId) {
        return true;
      }
      const lines = [
        `Model: ${activeModelLabel}`,
        `Reasoning: ${activeEffortLabel}`,
        `Mode: ${formatCollaborationModeLabel(selectedCollaborationMode)}`,
        `Default workspace: ${preferredStartCwd ?? 'Select project'}`,
      ];
      if (supportsFastMode) {
        lines.splice(2, 0, `Fast mode: ${fastModeEnabled ? 'On' : 'Off'}`);
      }
      if (selectedChat) {
        lines.push(`Chat: ${selectedChat.title || selectedChat.id}`);
        lines.push(`Chat workspace: ${selectedChat.cwd ?? 'Not set'}`);
        lines.push(`Chat status: ${selectedChat.status}`);
      }
      appendLocalAssistantMessage(lines.join('\n'), commandChatId);
      return true;
    },
    review: () => {
      if (!selectedChatId) {
        setError('/review requires an open chat');
        return Promise.resolve(true);
      }

      if (!supportsReview) {
        const detail = `Review is not supported for ${activeAgentLabel} chats.`;
        setError(detail);
        setActivity({
          tone: 'error',
          title: 'Review unavailable',
          detail,
        });
        return Promise.resolve(true);
      }

      try {
        setActivity({
          tone: 'running',
          title: 'Starting review',
        });
        throw new Error('Review is not advertised by this ACP agent.');
      } catch (err) {
        const message = (err as Error).message;
        setError(message);
        setActivity({
          tone: 'error',
          title: 'Review failed',
          detail: message,
        });
      }
      return Promise.resolve(true);
    },
    diff: () => {
      if (!selectedChat) {
        setError('/diff requires an open chat');
        return Promise.resolve(true);
      }
      onOpenGit(selectedChat);
      return Promise.resolve(true);
    },
  };

  const handler = handlers[name];
  return handler ? handler() : false;
}
