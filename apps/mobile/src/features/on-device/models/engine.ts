import type {
  CompletionParams,
  ContextParams,
  LlamaContext,
  NativeCompletionResult,
  RNLlamaOAICompatibleMessage,
  TokenData,
  ToolCall,
} from 'llama.rn';
import type { DeviceMemory, LocalModelDefinition, LocalModelFile } from './types';

export interface LocalModelMessage extends RNLlamaOAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export type LocalModelReply = Pick<
  NativeCompletionResult,
  | 'content'
  | 'reasoning_content'
  | 'tool_calls'
  | 'interrupted'
  | 'truncated'
  | 'stopped_limit'
  | 'stopped_eos'
  | 'stopped_word'
  | 'context_full'
  | 'tokens_predicted'
  | 'tokens_evaluated'
>;

export type LocalModelContext = Pick<
  LlamaContext,
  'getFormattedChat' | 'stopCompletion' | 'release' | 'isJinjaSupported'
> & {
  tokenize(text: string): Promise<{ tokens: number[] }>;
  completion(
    params: CompletionParams,
    callback?: (value: TokenData) => void,
  ): Promise<LocalModelReply>;
};

/** iOS refuses GPU work from background apps, so background inference runs on the CPU. */
export type LocalInferenceBackend = 'gpu' | 'cpu';

export interface LocalModelLoadOptions {
  contextTokens: number;
  memory: DeviceMemory;
  backend: LocalInferenceBackend;
}

export type LocalContextLoader = (
  model: LocalModelDefinition,
  file: LocalModelFile,
  options: LocalModelLoadOptions,
  progress: (percent: number) => void,
) => Promise<LocalModelContext>;

// A-series phones have two performance cores plus efficiency cores. In the foreground Metal runs
// every layer and CPU threads only drive sampling/grammar; background CPU inference keeps the same
// count so efficiency cores are not oversubscribed. Simulator inference is CPU-only on a Mac.
export const DEVICE_INFERENCE_THREADS = 4;
export const SIMULATOR_INFERENCE_THREADS = 6;
export const INFERENCE_BATCH_TOKENS = 512;
export const INFERENCE_MICRO_BATCH_TOKENS = 256;

export function nativeContextParams(
  model: LocalModelDefinition,
  file: LocalModelFile,
  { contextTokens, memory, backend }: LocalModelLoadOptions,
): ContextParams {
  return {
    model: modelFileSystemPath(file.uri),
    n_ctx: contextTokens,
    n_batch: INFERENCE_BATCH_TOKENS,
    n_ubatch: INFERENCE_MICRO_BATCH_TOKENS,
    n_threads: memory.isSimulator ? SIMULATOR_INFERENCE_THREADS : DEVICE_INFERENCE_THREADS,
    // One sequence: recurrent/hybrid state is allocated per sequence and only sequence 0 is used.
    n_parallel: 1,
    n_gpu_layers: memory.isSimulator || backend === 'cpu' ? 0 : 99,
    // Naming only the CPU leaves llama.cpp no offload device, so no operation is sent to Metal.
    ...(backend === 'cpu' && !memory.isSimulator ? { devices: ['CPU'] } : {}),
    cache_type_k: 'f16',
    cache_type_v: 'f16',
    ctx_shift: false,
    // Pure-attention models reuse the shared KV prefix natively; hybrid/SWA models need snapshots.
    state_cache_budget_mb: Math.floor(model.stateCacheBytes / (1024 * 1024)),
  };
}

export function modelFileSystemPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) {
    throw new Error('The verified model must be a local file.');
  }
  return decodeURIComponent(url.pathname);
}

export const loadNativeModelContext: LocalContextLoader = async (
  model,
  file,
  options,
  progress,
) => {
  const { initLlama } = await import('llama.rn');
  return initLlama(nativeContextParams(model, file, options), progress);
};
