import type {
  CompletionParams,
  FormattedChatResult,
  JinjaFormattedChatResult,
  TokenData,
} from 'llama.rn';
import type { OnDeviceNativeServices } from '../native/services.types';
import { localModelDefinition, requireLocalModelRuntime } from './catalog';
import {
  generationTokenBudget,
  iteratePromptCandidates,
  LocalContextFull,
  promptFits,
} from './contextWindow';
import type {
  LocalContextLoader,
  LocalInferenceBackend,
  LocalModelContext,
  LocalModelMessage,
  LocalModelReply,
} from './engine';
import { completionParams, decodeFailed } from './completion';
import {
  modelContextTokens,
  requireContextMemory,
  requireExecutionMemory,
  requireModelMemory,
  type ResidentModel,
} from './memory';
import type { LocalModelDefinition, LocalModelFile } from './types';
import { compactEarlierTurns, type LocalSummaryCheckpoint } from './summary';

export { LocalContextFull };

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

export interface LocalGenerationOptions {
  checkpoint?: LocalSummaryCheckpoint;
  outputTokens?: number;
}

/** Where the app is running; iOS refuses GPU work from background apps. */
export type LocalModelPlacement = 'foreground' | 'background';

/** Context recreations allowed for one completion before its turn fails. */
const DECODE_RECOVERIES = 2;

interface LoadedModel {
  definition: LocalModelDefinition;
  file: LocalModelFile;
  context: LocalModelContext;
  contextTokens: number;
  backend: LocalInferenceBackend;
  /** A native decode failed; ggml-metal fails every later decode until the context is recreated. */
  failed: boolean;
}

interface Generation {
  /** Replaced when the context is recreated on another backend mid-generation. */
  model: LoadedModel;
  /** The context is being recreated, so there is no native completion to stop. */
  relocating: boolean;
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

const EMPTY: LocalModelSessionSnapshot = {
  phase: 'empty',
  modelId: null,
  progress: 0,
  error: null,
  contextTokens: null,
};

function ready(model: LoadedModel): LocalModelSessionSnapshot {
  const { definition, contextTokens } = model;
  return { phase: 'ready', modelId: definition.id, progress: 100, error: null, contextTokens };
}

export class LocalModelSession {
  private current: LoadedModel | null = null;
  private loading: Promise<void> | null = null;
  private loadingModelId: string | null = null;
  private loadingEpoch = 0;
  private loadEpoch = 0;
  private generation: Generation | null = null;
  private failedCheckpoint: string | null = null;
  private unloading = false;
  private disposed = false;
  private placement: LocalModelPlacement = 'foreground';
  private simulator = false;
  private value = EMPTY;

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

  /**
   * Records whether the app is in the foreground. The next completion recreates the context on
   * the backend that placement allows: GPU work submitted from the background fails natively.
   */
  setPlacement(placement: LocalModelPlacement): void {
    this.placement = placement;
  }

  load(id: string): Promise<void> {
    if (this.disposed || this.unloading) {
      return Promise.reject(
        new Error('The on-device model is shutting down. Try again in a moment.'),
      );
    }
    const model = localModelDefinition(id);
    if (this.loading && this.loadingEpoch === this.loadEpoch && this.loadingModelId === id) {
      return this.loading;
    }
    // The latest request wins. A superseded or cancelled load still owns native memory until it
    // settles, so the new load queues behind it.
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
    options?: LocalGenerationOptions,
  ): Promise<LocalModelReply> {
    if (this.disposed || this.loading || this.unloading || !this.current || this.generation) {
      return Promise.reject(
        new Error('The on-device model is not ready yet. Wait for it to finish loading.'),
      );
    }
    const generation: Generation = {
      model: this.current,
      relocating: false,
      interrupted: false,
      lateStopRequested: false,
      stopFailure: null,
      promise: null,
    };
    this.generation = generation;
    generation.promise = this.performGeneration(generation, messages, tools, update, options);
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
      this.publish(EMPTY);
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
      if (!generation.relocating) {
        await generation.model.context.stopCompletion();
      }
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
      this.simulator = memory.isSimulator;
      const contextTokens = modelContextTokens(model, memory);
      const backend = this.backend();
      const context = await this.loadContext(
        model,
        file,
        { contextTokens, memory, backend },
        (progress) => {
          if (!this.cancelled(epoch)) {
            this.publish({ progress });
          }
        },
      );
      loaded = { definition: model, file, context, contextTokens, backend, failed: false };
      this.current = loaded;
      this.checkLoad(epoch);
      if (!context.isJinjaSupported()) {
        await this.releaseCurrent();
        throw new Error('This model does not support the verified native tool format.');
      }
      this.publish(ready(loaded));
    } catch (error) {
      if (error instanceof LocalModelInterrupted || this.cancelled(epoch)) {
        if (loaded && this.current === loaded) {
          await this.releaseCurrent();
        }
        if (!this.unloading && !this.disposed) {
          this.publish(this.current ? ready(this.current) : EMPTY);
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
    options?: LocalGenerationOptions,
  ): Promise<LocalModelReply> {
    try {
      this.requireExecutionMemory();
      this.publish({ phase: 'running', error: null });
      const thinking = roundThinks(generation.model.definition, options);
      const prompt = await this.preparePrompt(
        generation,
        messages,
        tools,
        thinking,
        options?.checkpoint,
      );
      if (generation.interrupted) {
        throw new LocalModelInterrupted();
      }
      return await this.complete(
        generation,
        completionParams(
          prompt.formatted,
          Math.min(
            generationTokenBudget(prompt.tokens, generation.model.contextTokens),
            options?.outputTokens === undefined
              ? Infinity
              : Math.max(1, Math.min(512, options.outputTokens)),
          ),
          thinking,
        ),
        (value) => this.partial(generation, value, update),
      );
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
   * completion so the template is rendered once per attempt. Stored history is never modified.
   */
  private async preparePrompt(
    generation: Generation,
    messages: LocalModelMessage[],
    tools: object[],
    thinking: boolean,
    checkpoint?: LocalSummaryCheckpoint,
  ): Promise<PreparedPrompt> {
    const { contextTokens } = generation.model;
    const original = await this.formatPrompt(generation, messages, tools, thinking);
    // Two free generation reserves always leave room for the next tool round. A summary that
    // failed for this earlier history is not retried; elision runs instead.
    if (
      checkpoint &&
      checkpoint.key !== this.failedCheckpoint &&
      !promptFits(original.tokens, contextTokens, 2)
    ) {
      const compacted = await compactEarlierTurns(messages, original, contextTokens, checkpoint, {
        format: (chat, withTools) =>
          // Summary prompts (no tools) never think; their output cap holds only memory.
          this.formatPrompt(generation, chat, withTools ? tools : [], withTools && thinking),
        complete: (prompt, outputTokens) => this.summaryReply(generation, prompt, outputTokens),
        failed: (error) => {
          this.checkGeneration(generation);
          if (error instanceof LocalModelInterrupted) {
            throw error;
          }
          this.requireExecutionMemory();
          this.failedCheckpoint = checkpoint.key;
        },
      });
      if (compacted) {
        return compacted;
      }
    }
    let fallback: PreparedPrompt | null = null;
    // A history candidate that fits is preferred to eliding the current turn's own output.
    for (const candidate of iteratePromptCandidates(messages, () => fallback !== null)) {
      const prepared =
        candidate.scope === 'original'
          ? original
          : await this.formatPrompt(generation, candidate.messages, tools, thinking);
      if (!promptFits(prepared.tokens, contextTokens)) {
        continue;
      }
      // Once compaction is needed, free extra room so the next rounds keep a stable prefix.
      if (candidate.scope !== 'history' || promptFits(prepared.tokens, contextTokens, 2)) {
        return prepared;
      }
      fallback ??= prepared;
    }
    if (fallback) {
      return fallback;
    }
    throw new LocalContextFull();
  }

  private checkGeneration(generation: Generation): void {
    if (generation.interrupted) {
      throw new LocalModelInterrupted();
    }
    if (generation.stopFailure) {
      throw generation.stopFailure;
    }
  }

  private async formatPrompt(
    generation: Generation,
    messages: LocalModelMessage[],
    tools: object[],
    thinking: boolean,
  ): Promise<PreparedPrompt> {
    this.checkGeneration(generation);
    const formatted = await generation.model.context.getFormattedChat(messages, null, {
      tools,
      tool_choice: tools.length ? 'auto' : 'none',
      enable_thinking: thinking,
      reasoning_format: 'auto',
    });
    const tokens = (await generation.model.context.tokenize(formatted.prompt)).tokens.length;
    this.checkGeneration(generation);
    return { formatted, tokens };
  }

  private async summaryReply(
    generation: Generation,
    prompt: PreparedPrompt,
    outputTokens: number,
  ): Promise<LocalModelReply> {
    this.requireExecutionMemory();
    this.checkGeneration(generation);
    return this.complete(generation, completionParams(prompt.formatted, outputTokens));
  }

  /**
   * Completes the formatted prompt on the backend the app placement allows. A failed native
   * decode, such as Metal refusing background work, recreates the context and evaluates the prompt
   * again, so the reply never carries the partial output of a failed evaluation.
   */
  private async complete(
    generation: Generation,
    params: CompletionParams,
    callback?: (value: TokenData) => void,
  ): Promise<LocalModelReply> {
    for (let recoveries = 0; ; recoveries += 1) {
      if (generation.model.failed || generation.model.backend !== this.backend()) {
        await this.relocate(generation);
      }
      const reply = await generation.model.context.completion(params, callback);
      if (generation.stopFailure) {
        throw generation.stopFailure;
      }
      if (generation.interrupted || reply.interrupted) {
        throw new LocalModelInterrupted();
      }
      if (!decodeFailed(reply)) {
        return reply;
      }
      generation.model.failed = true;
      if (recoveries === DECODE_RECOVERIES) {
        throw new Error('The local model could not evaluate the prompt. Try again.');
      }
    }
  }

  /** Recreates the generation's context, with the same window, on the preferred backend. */
  private async relocate(generation: Generation): Promise<void> {
    const previous = generation.model;
    this.checkGeneration(generation);
    if (this.current !== previous) {
      throw new LocalModelInterrupted();
    }
    generation.relocating = true;
    try {
      await this.releaseCurrent();
      this.checkGeneration(generation);
      const memory = this.native.getMemoryInfo();
      requireContextMemory(previous.definition, previous.contextTokens, memory);
      const backend = this.backend();
      const context = await this.loadContext(
        previous.definition,
        previous.file,
        { contextTokens: previous.contextTokens, memory, backend },
        () => undefined,
      );
      const relocated: LoadedModel = { ...previous, context, backend, failed: false };
      this.current = relocated;
      generation.model = relocated;
      this.checkGeneration(generation);
    } catch (error) {
      // The released model is gone; settle the session so the next turn loads it again.
      if (!this.current && !this.loading && !this.unloading && !this.disposed) {
        this.publish(
          generation.interrupted
            ? EMPTY
            : { phase: 'error', error: this.error(error).message, contextTokens: null },
        );
      }
      throw error;
    } finally {
      generation.relocating = false;
    }
  }

  private backend(): LocalInferenceBackend {
    // Simulator contexts already run on the CPU and never move.
    return this.simulator || this.placement === 'background' ? 'cpu' : 'gpu';
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
    requireExecutionMemory(this.native.getMemoryInfo());
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

/** Capped rounds (child agents) cannot spare output tokens for reasoning. */
function roundThinks(model: LocalModelDefinition, options?: LocalGenerationOptions): boolean {
  return model.thinking === true && options?.outputTokens === undefined;
}
