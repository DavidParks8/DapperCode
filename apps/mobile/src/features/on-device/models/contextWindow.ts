import { isRecord } from '@shared/records';
import type { LocalModelMessage } from './engine';

/** Tokens kept free beyond the prompt and generation for template/stop overhead. */
export const CONTEXT_SAFETY_TOKENS = 32;
/** Content shorter than this is never elided; markers would not save anything. */
const ELISION_MIN_CHARACTERS = 240;
const KEPT_RESULT_KEYS = [
  'path',
  'destination',
  'revision',
  'nextOffset',
  'truncated',
  'hash',
  'branch',
  'removed',
  'staged',
  'pushed',
  'error',
] as const;
export const OMITTED_TURNS_NOTE =
  'Earlier turns of this conversation were omitted to fit the local context window.';

/** The minimum generation budget that must remain free before a round may start. */
export function outputReserveTokens(contextTokens: number): number {
  return Math.min(2048, Math.floor(contextTokens / 4));
}

export function promptFits(
  promptTokens: number,
  contextTokens: number,
  reserveFactor = 1,
): boolean {
  return (
    promptTokens + outputReserveTokens(contextTokens) * reserveFactor + CONTEXT_SAFETY_TOKENS <=
    contextTokens
  );
}

/** Generation may use all context left after the prompt instead of a fixed small cap. */
export function generationTokenBudget(promptTokens: number, contextTokens: number): number {
  return contextTokens - promptTokens - CONTEXT_SAFETY_TOKENS;
}

export interface PromptCandidate {
  messages: LocalModelMessage[];
  /**
   * `history` candidates only shrink earlier turns. `current` candidates also elide the current
   * turn's own tool output and are used only when nothing else fits.
   */
  scope: 'original' | 'history' | 'current';
}

/**
 * Deterministic, progressively smaller model inputs. The current user message is never removed;
 * stored conversation history is never modified.
 */
export function promptCandidates(messages: readonly LocalModelMessage[]): PromptCandidate[] {
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const body = system ? messages.slice(1) : [...messages];
  const turns = splitTurns(body);
  const current = turns.pop() ?? [];
  const history = turns;
  const candidates: PromptCandidate[] = [{ messages: [...messages], scope: 'original' }];
  const compose = (keptHistory: LocalModelMessage[][], turn: LocalModelMessage[]) => {
    const omitted = keptHistory.length < history.length;
    const head: LocalModelMessage[] = system
      ? [omitted ? { ...system, content: `${system.content}\n\n${OMITTED_TURNS_NOTE}` } : system]
      : omitted
        ? [{ role: 'system', content: OMITTED_TURNS_NOTE }]
        : [];
    return [...head, ...keptHistory.flat(), ...turn];
  };
  if (history.length > 0) {
    const elided = history.map((turn) => turn.map((message) => elideMessage(message)));
    candidates.push({ messages: compose(elided, current), scope: 'history' });
    for (let dropped = 1; ; dropped *= 2) {
      const count = Math.min(dropped, elided.length);
      candidates.push({ messages: compose(elided.slice(count), current), scope: 'history' });
      if (count === elided.length) {
        break;
      }
    }
  }
  const lastAssistant = lastIndex(current, 'assistant');
  const lastTool = lastIndex(current, 'tool');
  if (lastAssistant > 0 || lastTool > 0) {
    const older = current.map((message, index) =>
      index === 0 || index === lastTool || index === lastAssistant
        ? message
        : elideMessage(message),
    );
    candidates.push({ messages: compose([], older), scope: 'current' });
    candidates.push({
      messages: compose(
        [],
        current.map((message, index) => (index === 0 ? message : elideMessage(message))),
      ),
      scope: 'current',
    });
  }
  return candidates;
}

function lastIndex(
  messages: readonly LocalModelMessage[],
  role: LocalModelMessage['role'],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

function splitTurns(messages: readonly LocalModelMessage[]): LocalModelMessage[][] {
  const turns: LocalModelMessage[][] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (message.role === 'user' || !last) {
      turns.push([message]);
    } else {
      last.push(message);
    }
  }
  return turns;
}

function elideMessage(message: LocalModelMessage): LocalModelMessage {
  if (message.role === 'tool') {
    return { ...message, content: elideToolResult(message.content) };
  }
  if (message.role !== 'assistant') {
    return message;
  }
  const rest: LocalModelMessage = { ...message };
  delete rest.reasoning_content;
  return message.tool_calls?.length
    ? {
        ...rest,
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          function: { ...call.function, arguments: elideArguments(call.function.arguments) },
        })),
      }
    : rest;
}

/** Keeps identifying fields (path, revision, error…) and replaces bulky output with a marker. */
export function elideToolResult(content: string): string {
  if (content.length < ELISION_MIN_CHARACTERS) {
    return content;
  }
  const kept: Record<string, unknown> = { elided: true };
  const parsed = parseRecord(content);
  if (parsed) {
    for (const key of KEPT_RESULT_KEYS) {
      const value = parsed[key];
      if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (typeof value === 'string' && value.length < ELISION_MIN_CHARACTERS)
      ) {
        kept[key] = value;
      }
    }
  }
  return JSON.stringify(kept);
}

function elideArguments(value: string): string {
  if (value.length < ELISION_MIN_CHARACTERS) {
    return value;
  }
  const parsed = parseRecord(value);
  if (!parsed) {
    return JSON.stringify({ elided: true });
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed).map(([key, entry]) => [
        key,
        typeof entry === 'string' && entry.length >= ELISION_MIN_CHARACTERS
          ? `[${entry.length} characters elided]`
          : entry,
      ]),
    ),
  );
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
