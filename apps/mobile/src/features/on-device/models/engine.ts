import type {
  CompletionParams,
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

export type LocalContextLoader = (
  model: LocalModelDefinition,
  file: LocalModelFile,
  memory: DeviceMemory,
  progress: (percent: number) => void,
) => Promise<LocalModelContext>;

export function modelFileSystemPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) {
    throw new Error('The verified model must be a local file.');
  }
  return decodeURIComponent(url.pathname);
}

export const loadNativeModelContext: LocalContextLoader = async (model, file, memory, progress) => {
  const { initLlama } = await import('llama.rn');
  return initLlama(
    {
      model: modelFileSystemPath(file.uri),
      n_ctx: model.contextTokens,
      n_batch: 128,
      n_threads: 2,
      n_gpu_layers: memory.isSimulator ? 0 : 99,
      cache_type_k: 'f16',
      cache_type_v: 'f16',
      ctx_shift: false,
      state_cache_budget_mb: 0,
    },
    progress,
  );
};
