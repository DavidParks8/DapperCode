import type { CompletionParams, FormattedChatResult, JinjaFormattedChatResult } from 'llama.rn';
import type { LocalModelReply } from './engine';
import type { LocalSummaryCheckpoint } from './summary';
import type { LocalModelDefinition } from './types';

export interface LocalModelSessionSnapshot {
  phase: 'empty' | 'loading' | 'ready' | 'running' | 'stopping' | 'error';
  modelId: string | null;
  progress: number;
  /** 0–99 while prompt processing is running, otherwise null. */
  promptProgress: number | null;
  /** A model-level failure (load or native stop). Turn failures belong to the conversation. */
  error: string | null;
  /** The context size of the resident model, chosen from fresh memory headroom at load. */
  contextTokens: number | null;
}

export interface LocalModelUpdate {
  content: string;
  reasoning: string;
}

export interface LocalGenerationOptions {
  checkpoint?: LocalSummaryCheckpoint;
  outputTokens?: number;
  /** Called synchronously right after native `completion()` is invoked (after initial PP progress). */
  onStart?: () => void;
}

/** Where the app is running; iOS refuses GPU work from background apps. */
export type LocalModelPlacement = 'foreground' | 'background';

export const EMPTY_MODEL_SESSION: LocalModelSessionSnapshot = {
  phase: 'empty',
  modelId: null,
  progress: 0,
  promptProgress: null,
  error: null,
  contextTokens: null,
};

export function readyModelSession(
  modelId: string,
  contextTokens: number,
): LocalModelSessionSnapshot {
  return {
    phase: 'ready',
    modelId,
    progress: 100,
    promptProgress: null,
    error: null,
    contextTokens,
  };
}

export class LocalModelInterrupted extends Error {
  constructor() {
    super('Local model work was interrupted.');
    this.name = 'LocalModelInterrupted';
  }
}

/** Capped rounds (child agents) cannot spare output tokens for reasoning. */
export function roundThinks(model: LocalModelDefinition, outputTokens?: number): boolean {
  return model.thinking === true && outputTokens === undefined;
}

/** Clamps a prompt-processing percentage into 0–99, or null once prompt processing finishes. */
export function normalizePromptProgress(value: number): number | null {
  return value >= 100 ? null : Math.max(0, Math.min(99, Math.floor(value)));
}

export function roundPredictBudget(
  availableBudget: number,
  outputTokens: number | undefined,
): number {
  return Math.min(
    availableBudget,
    outputTokens === undefined ? Infinity : Math.max(1, Math.min(512, outputTokens)),
  );
}

/**
 * Runs `onStart` after launching native completion, reissuing `stopCompletion` if the generation
 * was interrupted synchronously during launch (before native `rewind()`) or if `onStart` throws.
 */
export async function awaitStartedCompletion(
  pending: Promise<LocalModelReply>,
  onStart: (() => void) | undefined,
  generation: { interrupted: boolean },
  stopCompletion: () => Promise<void>,
): Promise<LocalModelReply> {
  const abort = () => {
    generation.interrupted = true;
    return Promise.resolve().then(stopCompletion);
  };
  if (!generation.interrupted) {
    try {
      onStart?.();
    } catch (error) {
      await Promise.allSettled([abort(), pending]);
      throw error;
    }
  }
  if (generation.interrupted) {
    await Promise.allSettled([abort(), pending]);
  }
  return pending;
}

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
