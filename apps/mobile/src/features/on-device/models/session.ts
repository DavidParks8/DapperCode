import type { TokenData } from 'llama.rn';
import type { OnDeviceNativeServices } from '../native/services.types';
import { localModelDefinition, requireLocalModelRuntime } from './catalog';
import type {
  LocalContextLoader,
  LocalModelContext,
  LocalModelMessage,
  LocalModelReply,
} from './engine';
import { MODEL_MEMORY_RESERVE_BYTES, requireModelMemory } from './memory';
import type { LocalModelDefinition } from './types';

export interface LocalModelSessionSnapshot {
  phase: 'empty' | 'loading' | 'ready' | 'running' | 'stopping' | 'error';
  modelId: string | null;
  progress: number;
  error: string | null;
}

export interface LocalModelUpdate {
  content: string;
  reasoning: string;
}

interface LoadedModel {
  definition: LocalModelDefinition;
  context: LocalModelContext;
}

interface Generation {
  model: LoadedModel;
  interrupted: boolean;
  lateStopRequested: boolean;
  stopFailure: Error | null;
  promise: Promise<LocalModelReply> | null;
}

export class LocalModelInterrupted extends Error {
  constructor() {
    super('Local model work was interrupted.');
    this.name = 'LocalModelInterrupted';
  }
}

export class LocalModelSession {
  private current: LoadedModel | null = null;
  private loading: Promise<void> | null = null;
  private loadingCancelled = false;
  private loadEpoch = 0;
  private generation: Generation | null = null;
  private unloading = false;
  private disposed = false;
  private value: LocalModelSessionSnapshot = {
    phase: 'empty',
    modelId: null,
    progress: 0,
    error: null,
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

  load(id: string): Promise<void> {
    if (this.disposed || this.loading || this.unloading) {
      return Promise.reject(
        new Error('The local model session is unavailable or changing models.'),
      );
    }
    const model = localModelDefinition(id);
    this.loadingCancelled = false;
    this.loading = this.performLoad(model, ++this.loadEpoch);
    return this.loading;
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

  async stop(): Promise<void> {
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

  async unload(): Promise<void> {
    this.unloading = true;
    this.loadingCancelled = true;
    this.loadEpoch += 1;
    this.publish({ phase: 'stopping' });
    try {
      if (this.loading) {
        // The load caller receives its error; disposal only waits for safe native ownership.
        await Promise.allSettled([this.loading]);
      }
      await this.stop();
      await this.releaseCurrent();
      this.publish({ phase: 'empty', modelId: null, progress: 0, error: null });
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

  private async performLoad(model: LocalModelDefinition, epoch: number): Promise<void> {
    try {
      requireLocalModelRuntime(model);
      await this.stop();
      await this.releaseCurrent();
      this.checkLoadingAllowed();
      this.publish({ phase: 'loading', modelId: model.id, progress: 0, error: null });
      const file = await this.native.getDownloadedModelFile(model.id);
      if (
        !file ||
        file.id !== model.id ||
        file.sha256 !== model.sha256 ||
        file.bytes !== model.bytes
      ) {
        throw new Error('Download and verify this catalog model before loading it.');
      }
      this.checkLoadingAllowed();
      const memory = this.native.getMemoryInfo();
      requireModelMemory(model, memory);
      const context = await this.loadContext(model, file, memory, (progress) => {
        if (epoch === this.loadEpoch && this.loading && !this.loadingCancelled && !this.disposed) {
          this.publish({ progress });
        }
      });
      this.current = { definition: model, context };
      if (this.loadingCancelled || this.disposed) {
        await this.releaseCurrent();
        throw new LocalModelInterrupted();
      }
      if (!context.isJinjaSupported()) {
        await this.releaseCurrent();
        throw new Error('This model does not support the verified native tool format.');
      }
      this.publish({ phase: 'ready', modelId: model.id, progress: 100, error: null });
    } catch (error) {
      if (!(error instanceof LocalModelInterrupted)) {
        this.publish({ phase: 'error', error: this.error(error).message });
      }
      throw error;
    } finally {
      this.loading = null;
    }
  }

  private async performGeneration(
    generation: Generation,
    messages: LocalModelMessage[],
    tools: object[],
    update: (value: LocalModelUpdate) => void,
  ): Promise<LocalModelReply> {
    let failed = false;
    try {
      this.requireExecutionMemory();
      this.publish({ phase: 'running', error: null });
      const context = generation.model.context;
      const formatted = await context.getFormattedChat(messages, null, {
        tools,
        tool_choice: 'auto',
        enable_thinking: false,
        reasoning_format: 'auto',
      });
      const tokens = await context.tokenize(formatted.prompt);
      if (tokens.tokens.length + 512 + 32 > generation.model.definition.contextTokens) {
        throw new Error(
          'The local context window is full. Start a new conversation or use smaller file reads.',
        );
      }
      if (generation.interrupted) {
        throw new LocalModelInterrupted();
      }
      const result = await context.completion(
        {
          messages,
          tools,
          tool_choice: 'auto',
          enable_thinking: false,
          reasoning_format: 'auto',
          temperature: 0.2,
          n_predict: 512,
        },
        (value) => this.partial(generation, value, update),
      );
      if (generation.stopFailure) {
        throw generation.stopFailure;
      }
      if (generation.interrupted || result.interrupted) {
        throw new LocalModelInterrupted();
      }
      return result;
    } catch (error) {
      if (!(error instanceof LocalModelInterrupted)) {
        failed = true;
        this.publish({ phase: 'error', error: this.error(error).message });
      }
      throw error;
    } finally {
      if (this.generation === generation) {
        this.generation = null;
      }
      if (
        !failed &&
        !this.loading &&
        !this.unloading &&
        !this.disposed &&
        this.current === generation.model
      ) {
        this.publish({ phase: 'ready' });
      }
    }
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

  private checkLoadingAllowed(): void {
    if (this.loadingCancelled || this.disposed) {
      throw new LocalModelInterrupted();
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
