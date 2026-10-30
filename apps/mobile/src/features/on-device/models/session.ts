import type {
  CompletionParams,
  FormattedChatResult,
  JinjaFormattedChatResult,
  TokenData,
} from 'llama.rn';
import type { OnDeviceNativeServices } from '../native/services.types';
import { localModelDefinition, requireLocalModelRuntime } from './catalog';
import { generationTokenBudget, promptCandidates, promptFits } from './contextWindow';
import type {
  LocalContextLoader,
  LocalModelContext,
  LocalModelMessage,
  LocalModelReply,
} from './engine';
import {
  MODEL_MEMORY_RESERVE_BYTES,
  modelContextTokens,
  requireModelMemory,
  type ResidentModel,
} from './memory';
import type { LocalModelDefinition } from './types';

export interface LocalModelSessionSnapshot {
  phase: 'empty' | 'loading' | 'ready' | 'running' | 'stopping' | 'error';
  modelId: string | null;
  progress: number;
  /** A model-level failure (load or native stop). Turn failures belong to the conversation. */
  error: string | null;
  /** The context size of the resident model, chosen from fresh memory headroom at load. */
  contextTokens: number | null;
}

export interface LocalModelUpdate {
  content: string;
  reasoning: string;
}

interface LoadedModel {
  definition: LocalModelDefinition;
  context: LocalModelContext;
  contextTokens: number;
}

interface Generation {
  model: LoadedModel;
  interrupted: boolean;
  lateStopRequested: boolean;
  stopFailure: Error | null;
  promise: Promise<LocalModelReply> | null;
}

interface PreparedPrompt {
  formatted: FormattedChatResult | JinjaFormattedChatResult;
  tokens: number;
}

export class LocalModelInterrupted extends Error {
  constructor() {
    super('Local model work was interrupted.');
    this.name = 'LocalModelInterrupted';
  }
}

export class LocalContextFull extends Error {
  constructor() {
    super(
      'This turn no longer fits in the local context window, even after omitting earlier turns and tool output. Start a new conversation or ask for a smaller step.',
    );
    this.name = 'LocalContextFull';
  }
}

export class LocalModelSession {
  private current: LoadedModel | null = null;
  private loading: Promise<void> | null = null;
  private loadingModelId: string | null = null;
  private loadingEpoch = 0;
  private loadEpoch = 0;
  private generation: Generation | null = null;
  private unloading = false;
  private disposed = false;
  private value: LocalModelSessionSnapshot = {
    phase: 'empty',
    modelId: null,
    progress: 0,
    error: null,
    contextTokens: null,
  };

  constructor(
    private readonly native: Pick<
      OnDeviceNativeServices,
      'getMemoryInfo' | 'getDownloadedModelFile'
    >,
    private readonly loadContext: LocalContextLoader,
    private readonly changed: (value: LocalModelSessionSnapshot) => void,
  ) {}

  snapshot(): LocalModelSessionSnapshot {
    return this.value;
  }

  /** The resident context that a new load would release first, for switch-aware admission. */
  resident(): ResidentModel | null {
    return this.current
      ? { model: this.current.definition, contextTokens: this.current.contextTokens }
      : null;
  }

  load(id: string): Promise<void> {
    if (this.disposed || this.unloading) {
      return Promise.reject(new Error('The local model session is unavailable.'));
    }
    const model = localModelDefinition(id);
    if (this.loading && this.loadingEpoch === this.loadEpoch) {
      if (this.loadingModelId === id) {
        return this.loading;
      }
      return Promise.reject(new Error('Wait for the current model to finish loading.'));
    }
    // A cancelled load still owns native memory until it settles; queue behind it.
    const previous = this.loading;
    const epoch = ++this.loadEpoch;
    this.loadingEpoch = epoch;
    this.loadingModelId = id;
    const promise = (async () => {
      if (previous) {
        await Promise.allSettled([previous]);
      }
      await this.performLoad(model, epoch);
    })().finally(() => {
      if (this.loading === promise) {
        this.loading = null;
        this.loadingModelId = null;
      }
    });
    this.loading = promise;
    return promise;
  }

  generate(
    messages: LocalModelMessage[],
    tools: object[],
    update: (value: LocalModelUpdate) => void,
  ): Promise<LocalModelReply> {
    if (this.disposed || this.loading || this.unloading || !this.current || this.generation) {
      return Promise.reject(
        new Error('Load an available local model and wait for the active work to settle.'),
      );
    }
    const generation: Generation = {
      model: this.current,
      interrupted: false,
      lateStopRequested: false,
      stopFailure: null,
      promise: null,
    };
    this.generation = generation;
    generation.promise = this.performGeneration(generation, messages, tools, update);
    return generation.promise;
  }

  /**
   * Stops local model work promptly. An in-flight load is cancelled without waiting for native
   * initialization; its context is released as soon as the native load returns.
   */
  async stop(): Promise<void> {
    this.cancelLoad();
    await this.stopGeneration();
  }

  async unload(): Promise<void> {
    this.unloading = true;
    this.loadEpoch += 1;
    this.publish({ phase: 'stopping' });
    try {
      if (this.loading) {
        // The load caller receives its error; disposal only waits for safe native ownership.
        await Promise.allSettled([this.loading]);
      }
      await this.stopGeneration();
      await this.releaseCurrent();
      this.publish({
        phase: 'empty',
        modelId: null,
        progress: 0,
        error: null,
        contextTokens: null,
      });
    } catch (error) {
      this.publish({ phase: 'error', error: this.error(error).message });
      throw error;
    } finally {
      this.unloading = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.unload();
  }

  private cancelLoad(): void {
    if (this.loading && this.loadingEpoch === this.loadEpoch) {
      this.loadEpoch += 1;
      this.publish({ phase: 'stopping' });
    }
  }

  private async stopGeneration(): Promise<void> {
    const generation = this.generation;
    if (!generation) {
      return;
    }
    generation.interrupted = true;
    this.publish({ phase: 'stopping' });
    try {
      await generation.model.context.stopCompletion();
    } catch (error) {
      generation.stopFailure = this.error(error);
      this.publish({ phase: 'error', error: generation.stopFailure.message });
      throw error;
    }
    if (generation.promise) {
      try {
        await generation.promise;
      } catch (error) {
        if (!(error instanceof LocalModelInterrupted)) {
          throw error;
        }
      }
    }
  }

  private cancelled(epoch: number): boolean {
    return epoch !== this.loadEpoch || this.disposed;
  }

  private checkLoad(epoch: number): void {
    if (this.cancelled(epoch)) {
      throw new LocalModelInterrupted();
    }
  }

  private async performLoad(model: LocalModelDefinition, epoch: number): Promise<void> {
    let loaded: LoadedModel | null = null;
    try {
      this.checkLoad(epoch);
      requireLocalModelRuntime(model);
      await this.stopGeneration();
      await this.releaseCurrent();
      this.checkLoad(epoch);
      this.publish({
        phase: 'loading',
        modelId: model.id,
        progress: 0,
        error: null,
        contextTokens: null,
      });
      const file = await this.native.getDownloadedModelFile(model.id);
      if (
        !file ||
        file.id !== model.id ||
        file.sha256 !== model.sha256 ||
        file.bytes !== model.bytes
      ) {
        throw new Error('Download and verify this catalog model before loading it.');
      }
      this.checkLoad(epoch);
      const memory = this.native.getMemoryInfo();
      requireModelMemory(model, memory);
      const contextTokens = modelContextTokens(model, memory);
      const context = await this.loadContext(model, file, { contextTokens, memory }, (progress) => {
        if (!this.cancelled(epoch)) {
          this.publish({ progress });
        }
      });
      loaded = { definition: model, context, contextTokens };
      this.current = loaded;
      this.checkLoad(epoch);
      if (!context.isJinjaSupported()) {
        await this.releaseCurrent();
        throw new Error('This model does not support the verified native tool format.');
      }
      this.publish({
        phase: 'ready',
        modelId: model.id,
        progress: 100,
        error: null,
        contextTokens,
      });
    } catch (error) {
      if (error instanceof LocalModelInterrupted || this.cancelled(epoch)) {
        if (loaded && this.current === loaded) {
          await this.releaseCurrent();
        }
        if (!this.unloading && !this.disposed) {
          const resident = this.current;
          this.publish(
            resident
              ? {
                  phase: 'ready',
                  modelId: resident.definition.id,
                  progress: 100,
                  error: null,
                  contextTokens: resident.contextTokens,
                }
              : { phase: 'empty', modelId: null, progress: 0, error: null, contextTokens: null },
          );
        }
        throw error instanceof LocalModelInterrupted ? error : new LocalModelInterrupted();
      }
      this.publish({
        phase: 'error',
        modelId: model.id,
        error: this.error(error).message,
        contextTokens: null,
      });
      throw error;
    }
  }

  private async performGeneration(
    generation: Generation,
    messages: LocalModelMessage[],
    tools: object[],
    update: (value: LocalModelUpdate) => void,
  ): Promise<LocalModelReply> {
    try {
      this.requireExecutionMemory();
      this.publish({ phase: 'running', error: null });
      const prompt = await this.preparePrompt(generation, messages, tools);
      if (generation.interrupted) {
        throw new LocalModelInterrupted();
      }
      const result = await generation.model.context.completion(
        completionParams(
          prompt.formatted,
          generationTokenBudget(prompt.tokens, generation.model.contextTokens),
        ),
        (value) => this.partial(generation, value, update),
      );
      if (generation.stopFailure) {
        throw generation.stopFailure;
      }
      if (generation.interrupted || result.interrupted) {
        throw new LocalModelInterrupted();
      }
      return result;
    } finally {
      if (this.generation === generation) {
        this.generation = null;
      }
      // Turn failures leave a healthy resident model ready; only an unknown native stop state is
      // a model error.
      if (
        !generation.stopFailure &&
        !this.loading &&
        !this.unloading &&
        !this.disposed &&
        this.current === generation.model
      ) {
        this.publish({ phase: 'ready' });
      }
    }
  }

  /**
   * Formats with the real chat template and tokenizer, compacting earlier context only when the
   * prompt would not leave room to generate. The chosen formatted prompt is passed straight to
   * completion so the template is rendered once per attempt.
   */
  private async preparePrompt(
    generation: Generation,
    messages: LocalModelMessage[],
    tools: object[],
  ): Promise<PreparedPrompt> {
    const { context, contextTokens } = generation.model;
    let fallback: PreparedPrompt | null = null;
    for (const candidate of promptCandidates(messages)) {
      if (generation.interrupted) {
        throw new LocalModelInterrupted();
      }
      if (candidate.scope === 'current' && fallback) {
        return fallback;
      }
      const formatted = await context.getFormattedChat(candidate.messages, null, {
        tools,
        tool_choice: 'auto',
        enable_thinking: false,
        reasoning_format: 'auto',
      });
      const tokens = (await context.tokenize(formatted.prompt)).tokens.length;
      if (!promptFits(tokens, contextTokens)) {
        continue;
      }
      // Once compaction is needed, free extra room so the next rounds keep a stable prefix.
      if (candidate.scope !== 'history' || promptFits(tokens, contextTokens, 2)) {
        return { formatted, tokens };
      }
      fallback ??= { formatted, tokens };
    }
    if (fallback) {
      return fallback;
    }
    throw new LocalContextFull();
  }

  private partial(
    generation: Generation,
    value: TokenData,
    update: (value: LocalModelUpdate) => void,
  ): void {
    if (this.generation !== generation || this.disposed) {
      return;
    }
    if (generation.interrupted) {
      if (!generation.lateStopRequested) {
        generation.lateStopRequested = true;
        void generation.model.context.stopCompletion().catch((error: unknown) => {
          generation.stopFailure = this.error(error);
          if (this.generation === generation && !this.disposed) {
            this.publish({ phase: 'error', error: generation.stopFailure.message });
          }
        });
      }
      return;
    }
    if (value.accumulated_text !== undefined) {
      update({ content: value.content ?? '', reasoning: value.reasoning_content ?? '' });
    }
  }

  private requireExecutionMemory(): void {
    const memory = this.native.getMemoryInfo();
    if (
      !Number.isSafeInteger(memory.availableBytes) ||
      memory.availableBytes < MODEL_MEMORY_RESERVE_BYTES
    ) {
      throw new Error('iOS memory headroom is too low to run this model safely.');
    }
  }

  private async releaseCurrent(): Promise<void> {
    const current = this.current;
    if (current) {
      await current.context.release();
      if (this.current === current) {
        this.current = null;
      }
    }
  }

  private publish(patch: Partial<LocalModelSessionSnapshot>): void {
    this.value = { ...this.value, ...patch };
    this.changed(this.value);
  }

  private error(error: unknown): Error {
    return error instanceof Error ? error : new Error('The native model operation failed.');
  }
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
    enable_thinking: false,
    reasoning_format: 'auto',
    temperature: 0.2,
    n_predict: nPredict,
  };
}
