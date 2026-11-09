import type { LocalModelReply } from '../models/engine';
import { randomUUID } from 'expo-crypto';
import type { LocalAgentRun, LocalToolCall } from './types';

export class LocalStepLimit extends Error {}

export function interruptLocalRun<T>(run: LocalAgentRun, work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  return Promise.race([work, run.interrupt]);
}

export function localReplyToolCalls(reply: LocalModelReply): LocalToolCall[] {
  return (reply.tool_calls ?? []).map((call) => ({
    id: randomUUID(),
    type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments },
  }));
}

export function requireLocalAnswer(reply: LocalModelReply): void {
  if (reply.truncated || reply.stopped_limit) {
    throw new LocalStepLimit(
      'The local model reached its output limit. Review the partial response and continue explicitly.',
    );
  }
  if (!reply.content?.trim()) {
    throw new Error('The model returned neither an answer nor a tool call.');
  }
}

/** The third identical consecutive call is not run; a further repeat ends the turn. */
export const REPEATED_TOOL_CALL_LIMIT = 3;

export function repeatedToolCallError(name: string): string {
  return `Not run: this is the same ${name} call with the same arguments ${String(REPEATED_TOOL_CALL_LIMIT)} times in a row, so its result would not change. Use the earlier result, try a different tool or arguments, or answer.`;
}

const TITLE_LIMIT = 60;

/** The first message's first line, cut at a word boundary when longer than the drawer can show. */
export function localConversationTitle(input: string): string {
  const line = input.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  if (line.length <= TITLE_LIMIT) {
    return line || 'New local conversation';
  }
  const cut = line.slice(0, TITLE_LIMIT - 1);
  const boundary = cut.lastIndexOf(' ');
  const words = boundary >= TITLE_LIMIT / 2 ? cut.slice(0, boundary) : cut;
  return `${words.replace(/[\s.,;:!?-]+$/u, '')}…`;
}
