import { nonEmptyString, record } from '@bridge/agui/agUiValueReaders';
import type { AgentCommand } from '@bridge/types/chat';

/** Custom AG-UI event carrying the slash commands an agent currently advertises. */
export const AGENT_COMMANDS_EVENT_NAME = 'dappercode.dev/commands';

/** Reads the `commands` list shared by ACP snapshots and the commands AG-UI event. */
export function parseAgentCommands(value: unknown): AgentCommand[] {
  const commands = record(value)?.['commands'];
  return (Array.isArray(commands) ? commands : []).flatMap((item) => {
    const entry = record(item);
    const name = nonEmptyString(entry?.['name']);
    if (!name) {
      return [];
    }
    const description = typeof entry?.['description'] === 'string' ? entry['description'] : '';
    const hint = nonEmptyString(entry?.['hint']);
    return [hint ? { name, description, hint } : { name, description }];
  });
}
