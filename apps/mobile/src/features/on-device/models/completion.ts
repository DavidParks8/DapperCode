import type { CompletionParams, FormattedChatResult, JinjaFormattedChatResult } from 'llama.rn';
import type { LocalModelReply } from './engine';

/**
 * llama.rn ends a completion without any stop reason when a native decode fails, for example when
 * iOS refuses GPU work from a background app. Metal then fails every later decode until the
 * context is recreated.
 */
export function decodeFailed(reply: LocalModelReply): boolean {
  return (
    !reply.interrupted &&
    !reply.stopped_eos &&
    !reply.stopped_word &&
    !reply.stopped_limit &&
    !reply.context_full
  );
}

// Fields of llama.rn's Jinja formatting result that its own messages path forwards to completion.
const FORMATTED_COMPLETION_KEYS = [
  'chat_format',
  'grammar',
  'grammar_lazy',
  'grammar_triggers',
  'preserved_tokens',
  'generation_prompt',
  'thinking_forced_open',
  'thinking_start_tag',
  'thinking_end_tag',
  'chat_parser',
] as const;

/** Mirrors llama.rn's own messages-to-prompt mapping so completion reuses one formatted prompt. */
export function completionParams(
  formatted: FormattedChatResult | JinjaFormattedChatResult,
  nPredict: number,
  thinking = false,
): CompletionParams {
  const jinja: JinjaFormattedChatResult =
    formatted.type === 'jinja'
      ? formatted
      : {
          type: formatted.type,
          prompt: formatted.prompt,
          has_media: formatted.has_media,
        };
  const forwarded: Partial<CompletionParams> = Object.fromEntries(
    FORMATTED_COMPLETION_KEYS.flatMap((key) => {
      const value = jinja[key];
      return value === undefined || value === null || value === '' ? [] : [[key, value]];
    }),
  );
  return {
    ...forwarded,
    ...(jinja.additional_stops ? { stop: [...jinja.additional_stops] } : {}),
    prompt: formatted.prompt,
    enable_thinking: thinking,
    reasoning_format: 'auto',
    temperature: 0.2,
    n_predict: nPredict,
  };
}
