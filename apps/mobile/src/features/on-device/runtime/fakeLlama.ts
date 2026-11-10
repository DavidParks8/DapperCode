/* eslint-disable @typescript-eslint/require-await -- the fake mirrors async llama.rn APIs */
import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';

import type {
  LocalContextLoader,
  LocalInferenceBackend,
  LocalModelContext,
  LocalModelReply,
} from '../models/engine';
import { residentModelBytes } from '../models/memory';

/** One scripted model reply. Tool calls are emitted the way llama.rn reports them. */
export interface ScriptedReply {
  content?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** Rejects the completion, as a native generation failure does. */
  fail?: string;
}

interface HeldStep {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Deterministic stand-in for llama.rn contexts that keeps the real runtime's ordering: loads report
 * progress and may be held, completions stream tokens and may be held, `stopCompletion` interrupts
 * a held completion, and each live context occupies the memory its catalog entry estimates.
 */
export class FakeLlama {
  /** Every load request, in order. */
  readonly loads: { modelId: string; contextTokens: number; backend: LocalInferenceBackend }[] = [];
  readonly executions: string[] = [];
  readonly tokenCallbacks: Array<(text: string) => void> = [];
  readonly resourceEvents: {
    type: 'initializing' | 'ready' | 'releasing' | 'released';
    modelId: string;
  }[] = [];
  private readonly owners = new Set<object>();
  ownershipHighWater = 0;
  /** Token counts of every prompt passed to completion, in order. */
  readonly promptTokens: number[] = [];
  /** `n_predict` of every completion, in order. */
  readonly predictBudgets: number[] = [];
  /** Live (unreleased) contexts with the memory each holds. */
  readonly resident = new Map<object, { modelId: string; bytes: number }>();
  /** Characters per token used by the fake tokenizer. */
  charactersPerToken = 4;
  holdLoads = false;
  holdCompletions = false;
  /** Keeps `stopCompletion` pending until `finishStop`, so the stopping phase is observable. */
  holdStops = false;
  holdReleases = false;
  /**
   * Makes GPU contexts fail every decode, as Metal does once iOS refuses GPU work from a
   * background app: the completion ends without any stop reason and its script is not consumed.
   */
  refuseGpu = false;
  /** Completions that ended in a refused GPU decode. */
  decodeFailures = 0;
  private releaseStep: HeldStep | null = null;
  /** Completions interrupted by `stopCompletion`. */
  stops = 0;
  private stopStep: (() => void) | null = null;
  private replies: ScriptedReply[] = [];
  private loadStep: (HeldStep & { progress: (value: number) => void }) | null = null;
  private completionStep: (HeldStep & { stream: (text: string) => void }) | null = null;
  releases = 0;

  /** Queues replies; once empty, every completion answers "Done.". */
  reply(...replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  get loadPending(): boolean {
    return this.loadStep !== null;
  }

  get completionPending(): boolean {
    return this.completionStep !== null;
  }

  residentBytes(): number {
    return [...this.resident.values()].reduce((total, entry) => total + entry.bytes, 0);
  }

  loadProgress(percent: number): void {
    this.loadStep?.progress(percent);
  }

  finishLoad(): void {
    const step = this.loadStep;
    this.loadStep = null;
    step?.resolve();
  }

  failLoad(message: string): void {
    const step = this.loadStep;
    this.loadStep = null;
    step?.reject(new Error(message));
  }

  /** Streams accumulated text into a held completion. */
  stream(text: string): void {
    this.completionStep?.stream(text);
  }

  finishCompletion(): void {
    const step = this.completionStep;
    this.completionStep = null;
    step?.resolve();
  }

  finishStop(): void {
    const step = this.stopStep;
    this.stopStep = null;
    step?.();
  }

  get releasePending(): boolean {
    return this.releaseStep !== null;
  }

  finishRelease(): void {
    const step = this.releaseStep;
    this.releaseStep = null;
    step?.resolve();
  }

  failRelease(message: string): void {
    const step = this.releaseStep;
    this.releaseStep = null;
    step?.reject(new Error(message));
  }

  readonly loader: LocalContextLoader = async (model, _file, options, progress) => {
    const owner = {};
    this.owners.add(owner);
    this.ownershipHighWater = Math.max(this.ownershipHighWater, this.owners.size);
    this.resourceEvents.push({ type: 'initializing', modelId: model.id });
    this.loads.push({
      modelId: model.id,
      contextTokens: options.contextTokens,
      backend: options.backend,
    });
    try {
      progress(0);
      if (this.holdLoads) {
        await new Promise<void>((resolve, reject) => {
          this.loadStep = { resolve, reject, progress };
        });
      }
      progress(100);
      const context = this.context(model.id, owner, options.backend);
      this.resident.set(context, {
        modelId: model.id,
        bytes: residentModelBytes({ model, contextTokens: options.contextTokens }),
      });
      this.resourceEvents.push({ type: 'ready', modelId: model.id });
      return context;
    } catch (error) {
      this.owners.delete(owner);
      throw error;
    }
  };

  private context(
    modelId: string,
    owner: object,
    backend: LocalInferenceBackend,
  ): LocalModelContext {
    let interrupted = false;
    const context: LocalModelContext = {
      getFormattedChat: async (messages): Promise<FormattedChatResult> => ({
        type: 'jinja',
        prompt: JSON.stringify(messages),
        has_media: false,
      }),
      tokenize: async (text: string) => ({
        tokens: new Array<number>(Math.ceil(text.length / this.charactersPerToken)).fill(1),
      }),
      completion: async (params: CompletionParams, callback?: (value: TokenData) => void) => {
        this.executions.push(modelId);
        interrupted = false;
        this.promptTokens.push(Math.ceil((params.prompt ?? '').length / this.charactersPerToken));
        this.predictBudgets.push(params.n_predict ?? -1);
        const script = this.replies.shift() ?? { content: 'Done.' };
        const emit = (text: string) =>
          callback?.({ token: text, content: text, accumulated_text: text });
        this.tokenCallbacks.push(emit);
        if (this.holdCompletions) {
          await new Promise<void>((resolve, reject) => {
            this.completionStep = { resolve, reject, stream: emit };
          });
        }
        if (script.fail) {
          throw new Error(script.fail);
        }
        if (!interrupted && backend === 'gpu' && this.refuseGpu) {
          this.decodeFailures += 1;
          this.replies.unshift(script);
          return { ...reply({}, false), stopped_eos: false };
        }
        if (!interrupted && script.content) {
          emit(script.content);
        }
        return reply(script, interrupted);
      },
      stopCompletion: async () => {
        this.stops += 1;
        if (this.holdStops) {
          await new Promise<void>((resolve) => {
            this.stopStep = resolve;
          });
        }
        interrupted = true;
        this.finishCompletion();
      },
      release: async () => {
        this.resourceEvents.push({ type: 'releasing', modelId });
        if (this.holdReleases) {
          await new Promise<void>((resolve, reject) => {
            this.releaseStep = { resolve, reject };
          });
        }
        this.releases += 1;
        this.resident.delete(context);
        this.owners.delete(owner);
        this.resourceEvents.push({ type: 'released', modelId });
      },
      isJinjaSupported: () => true,
    };
    return context;
  }
}

function reply(script: ScriptedReply, interrupted: boolean): LocalModelReply {
  return {
    content: interrupted ? '' : (script.content ?? ''),
    reasoning_content: '',
    tool_calls: interrupted
      ? []
      : (script.toolCalls ?? []).map((call, index) => ({
          type: 'function' as const,
          id: `call-${String(index)}`,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
    interrupted,
    truncated: false,
    stopped_limit: 0,
    stopped_eos: true,
    stopped_word: '',
    context_full: false,
    tokens_predicted: 1,
    tokens_evaluated: 1,
  };
}
