import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';
import { localModelDefinition } from './catalog';
import { CONTEXT_SAFETY_TOKENS, outputReserveTokens } from './contextWindow';
import type {
  LocalContextLoader,
  LocalModelContext,
  LocalModelMessage,
  LocalModelReply,
} from './engine';
import { modelFileSystemPath, nativeContextParams } from './engine';
import { MODEL_MEMORY_RESERVE_BYTES, modelMemoryBytes } from './memory';
import {
  LocalContextFull,
  LocalModelInterrupted,
  LocalModelSession,
  type LocalModelSessionSnapshot,
} from './session';

const small = localModelDefinition('qwen3-0.6b-q4-0');
const medium = localModelDefinition('qwen3-1.7b-q4-k-m');
const messages = [{ role: 'user' as const, content: 'Hello' }];
const formatted: FormattedChatResult = {
  type: 'jinja',
  prompt: 'formatted prompt',
  has_media: false,
};
const reply: LocalModelReply = {
  content: 'Hello',
  reasoning_content: '',
  tool_calls: [],
  interrupted: false,
  truncated: false,
  stopped_limit: 0,
  tokens_predicted: 1,
  tokens_evaluated: 10,
};

test('verified model URIs are decoded once for the native llama filesystem API', () => {
  expect(modelFileSystemPath('file:///Library/Application%20Support/models/model.gguf')).toBe(
    '/Library/Application Support/models/model.gguf',
  );
  expect(modelFileSystemPath('file:///models/literal%2520name.gguf')).toBe(
    '/models/literal%20name.gguf',
  );
  expect(() => modelFileSystemPath('https://example.com/model.gguf')).toThrow('local file');
  expect(() => modelFileSystemPath('file://other-host/model.gguf')).toThrow('local file');
});

test('native context tuning uses the admitted context, one sequence, and hybrid prompt reuse', () => {
  const file = { id: small.id, uri: 'file:///m.gguf', sha256: small.sha256, bytes: small.bytes };
  const device = {
    physicalBytes: 8 * 1024 ** 3,
    availableBytes: 4 * 1024 ** 3,
    isSimulator: false,
  };
  expect(nativeContextParams(small, file, { contextTokens: 8192, memory: device })).toMatchObject({
    n_ctx: 8192,
    n_parallel: 1,
    n_threads: 4,
    n_batch: 512,
    n_gpu_layers: 99,
    state_cache_budget_mb: 0,
  });
  const hybrid = localModelDefinition('qwen35-0.8b-q4-0');
  expect(
    nativeContextParams(hybrid, file, {
      contextTokens: 4096,
      memory: { ...device, isSimulator: true },
    }),
  ).toMatchObject({ n_ctx: 4096, n_threads: 6, n_gpu_layers: 0, state_cache_budget_mb: 128 });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function context() {
  return {
    getFormattedChat: jest.fn<
      Promise<FormattedChatResult>,
      Parameters<LocalModelContext['getFormattedChat']>
    >(async () => formatted),
    tokenize: jest.fn<Promise<{ tokens: number[] }>, [string]>(async () => ({
      tokens: [1, 2, 3],
    })),
    completion: jest.fn<
      Promise<LocalModelReply>,
      [CompletionParams, ((value: TokenData) => void)?]
    >(async () => reply),
    stopCompletion: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    isJinjaSupported: jest.fn(() => true),
  } satisfies LocalModelContext;
}

function harness() {
  const native = {
    getMemoryInfo: jest.fn(() => ({
      physicalBytes: 32 * 1024 ** 3,
      availableBytes: 16 * 1024 ** 3,
      isSimulator: true,
    })),
    getDownloadedModelFile: jest.fn(async (id: string) => {
      const model = localModelDefinition(id);
      return { id, bytes: model.bytes, sha256: model.sha256, uri: `file:///models/${id}.gguf` };
    }),
  };
  const initial = context();
  const loader = jest.fn<ReturnType<LocalContextLoader>, Parameters<LocalContextLoader>>(
    async () => initial,
  );
  const events: LocalModelSessionSnapshot[] = [];
  const session = new LocalModelSession(native, loader, (state) => events.push(state));
  return { native, initial, loader, events, session };
}

test('a Prism-only packing is rejected before native file access or model allocation', async () => {
  const h = harness();
  await expect(h.session.load('bonsai-2-2b-pq2-0')).rejects.toThrow('PrismML-specific runtime');
  expect(h.native.getDownloadedModelFile).not.toHaveBeenCalled();
  expect(h.loader).not.toHaveBeenCalled();
  expect(h.session.snapshot()).toMatchObject({ phase: 'error' });
});

test('model switching releases the old native context before fresh memory admission and allocation', async () => {
  const h = harness();
  const second = context();
  await h.session.load(small.id);
  const order: string[] = [];
  h.initial.release.mockImplementation(async () => {
    order.push('release');
  });
  h.native.getMemoryInfo.mockImplementation(() => {
    order.push('memory');
    return { physicalBytes: 32 * 1024 ** 3, availableBytes: 16 * 1024 ** 3, isSimulator: true };
  });
  h.loader.mockImplementation(async () => {
    order.push('load');
    return second;
  });
  await h.session.load(medium.id);
  expect(order).toEqual(['release', 'memory', 'load']);
  expect(h.session.snapshot()).toMatchObject({ phase: 'ready', modelId: medium.id });
});

test('failed post-unload admission cannot allocate a second context', async () => {
  const h = harness();
  await h.session.load(small.id);
  h.native.getMemoryInfo.mockReturnValue({
    physicalBytes: 32 * 1024 ** 3,
    availableBytes: modelMemoryBytes(medium) - 1,
    isSimulator: true,
  });
  await expect(h.session.load(medium.id)).rejects.toThrow('Not enough app memory');
  expect(h.initial.release).toHaveBeenCalledTimes(1);
  expect(h.loader).toHaveBeenCalledTimes(1);
  expect(h.session.snapshot().phase).toBe('error');
});

test('stop during formatting settles without ever admitting native generation', async () => {
  const h = harness();
  await h.session.load(small.id);
  const pending = deferred<FormattedChatResult>();
  const started = deferred<void>();
  h.initial.getFormattedChat.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const operation = h.session.generate(messages, [], jest.fn());
  const interrupted = operation.catch((error: unknown) => error);
  await started.promise;
  const stop = h.session.stop();
  pending.resolve(formatted);
  await stop;
  expect(await interrupted).toBeInstanceOf(LocalModelInterrupted);
  expect(h.initial.completion).not.toHaveBeenCalled();
  expect(h.session.snapshot().phase).toBe('ready');
});

test('stop remains stopping until the native worker settles and suppresses late output', async () => {
  const h = harness();
  await h.session.load(small.id);
  const pending = deferred<LocalModelReply>();
  const started = deferred<void>();
  let emit: ((value: TokenData) => void) | undefined;
  h.initial.completion.mockImplementation((_params, callback) => {
    emit = callback;
    started.resolve();
    return pending.promise;
  });
  const update = jest.fn();
  const operation = h.session.generate(messages, [], update);
  const interrupted = operation.catch((error: unknown) => error);
  await started.promise;
  const stopped = h.session.stop();
  expect(h.session.snapshot().phase).toBe('stopping');
  emit?.({ token: 'late', accumulated_text: 'late', content: 'late' });
  expect(update).not.toHaveBeenCalled();
  expect(h.initial.release).not.toHaveBeenCalled();
  pending.resolve({ ...reply, interrupted: true });
  await stopped;
  expect(await interrupted).toBeInstanceOf(LocalModelInterrupted);
  expect(h.session.snapshot().phase).toBe('ready');
  expect(h.events.map((state) => state.phase)).toEqual(
    expect.arrayContaining(['running', 'stopping', 'ready']),
  );
});

test('disposal during loading waits for and releases the unpublished native context', async () => {
  const h = harness();
  const pending = deferred<LocalModelContext>();
  const started = deferred<void>();
  h.loader.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const loading = h.session.load(small.id);
  const interrupted = loading.catch((error: unknown) => error);
  await started.promise;
  const disposed = h.session.dispose();
  pending.resolve(h.initial);
  await disposed;
  expect(await interrupted).toBeInstanceOf(LocalModelInterrupted);
  expect(h.initial.release).toHaveBeenCalledTimes(1);
  expect(h.session.snapshot()).toMatchObject({ phase: 'empty', modelId: null, progress: 0 });
  h.loader.mock.calls[0]![3](99);
  expect(h.session.snapshot()).toMatchObject({ phase: 'empty', progress: 0 });
  await expect(h.session.load(small.id)).rejects.toThrow('shutting down');
});

test('native stream snapshots are not duplicated or replaced with raw tool syntax', async () => {
  const h = harness();
  await h.session.load(small.id);
  h.initial.completion.mockImplementation(async (_params, callback) => {
    callback?.({ token: '<tool_' });
    callback?.({ token: 'h', accumulated_text: 'h', content: 'h' });
    callback?.({ token: 'i', accumulated_text: 'hi', content: 'hi' });
    return reply;
  });
  const update = jest.fn();
  await h.session.generate(messages, [], update);
  expect(update.mock.calls).toEqual([
    [{ content: 'h', reasoning: '' }],
    [{ content: 'hi', reasoning: '' }],
  ]);
});

test('execution checks only new headroom and does not count already-loaded weights twice', async () => {
  const h = harness();
  await h.session.load(small.id);
  h.native.getMemoryInfo.mockReturnValue({
    physicalBytes: 32 * 1024 ** 3,
    availableBytes: MODEL_MEMORY_RESERVE_BYTES,
    isSimulator: true,
  });
  await expect(h.session.generate(messages, [], jest.fn())).resolves.toMatchObject({
    content: 'Hello',
  });
  h.native.getMemoryInfo.mockReturnValue({
    physicalBytes: 32 * 1024 ** 3,
    availableBytes: MODEL_MEMORY_RESERVE_BYTES - 1,
    isSimulator: true,
  });
  await expect(h.session.generate(messages, [], jest.fn())).rejects.toThrow('headroom is too low');
  expect(h.initial.completion).toHaveBeenCalledTimes(1);
});

test('prompt budgets keep the reserved generation room at the exact context threshold', async () => {
  const h = harness();
  await h.session.load(small.id);
  const contextTokens = h.session.snapshot().contextTokens ?? 0;
  expect(contextTokens).toBe(small.maxContextTokens);
  const limit = contextTokens - outputReserveTokens(contextTokens) - CONTEXT_SAFETY_TOKENS;
  h.initial.tokenize.mockResolvedValue({ tokens: Array.from({ length: limit }, () => 1) });
  await h.session.generate(messages, [], jest.fn());
  h.initial.tokenize.mockResolvedValue({ tokens: Array.from({ length: limit + 1 }, () => 1) });
  await expect(h.session.generate(messages, [], jest.fn())).rejects.toBeInstanceOf(
    LocalContextFull,
  );
  expect(h.initial.completion).toHaveBeenCalledTimes(1);
  // A turn that does not fit is a conversation failure, not a broken model.
  expect(h.session.snapshot()).toMatchObject({ phase: 'ready', error: null });
});

test('generation may use all remaining context instead of a fixed 512-token output cap', async () => {
  const h = harness();
  await h.session.load(small.id);
  h.initial.tokenize.mockResolvedValue({ tokens: Array.from({ length: 1000 }, () => 1) });
  await h.session.generate(messages, [], jest.fn());
  const params = h.initial.completion.mock.calls[0]![0];
  expect(params.n_predict).toBe(small.maxContextTokens - 1000 - CONTEXT_SAFETY_TOKENS);
  expect(params.n_predict).toBeGreaterThan(4096);
});

test('each round renders the chat template once and completes from that formatted prompt', async () => {
  const h = harness();
  await h.session.load(small.id);
  h.initial.getFormattedChat.mockResolvedValue({
    ...formatted,
    chat_format: 7,
    grammar: 'root ::= "x"',
    grammar_lazy: true,
    grammar_triggers: [{ type: 1, value: '<tool_call>', token: 0 }],
    preserved_tokens: ['<tool_call>'],
    additional_stops: ['<|im_end|>'],
    generation_prompt: '<|im_start|>assistant\n',
    chat_parser: 'parser',
  } as FormattedChatResult);
  await h.session.generate(messages, [{ type: 'function' }], jest.fn());
  expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(1);
  const params = h.initial.completion.mock.calls[0]![0];
  expect(params).toMatchObject({
    prompt: 'formatted prompt',
    chat_format: 7,
    grammar: 'root ::= "x"',
    grammar_lazy: true,
    preserved_tokens: ['<tool_call>'],
    stop: ['<|im_end|>'],
    generation_prompt: '<|im_start|>assistant\n',
    chat_parser: 'parser',
    enable_thinking: false,
  });
  expect(params.messages).toBeUndefined();
  expect(params.tools).toBeUndefined();
});

test('a full context compacts earlier tool output and turns instead of ending the conversation', async () => {
  const h = harness();
  // Admit only the minimum context so the conversation genuinely overflows it.
  h.native.getMemoryInfo.mockReturnValue({
    physicalBytes: 32 * 1024 ** 3,
    availableBytes: modelMemoryBytes(small),
    isSimulator: true,
  });
  await h.session.load(small.id);
  expect(h.session.snapshot().contextTokens).toBe(small.contextTokens);
  h.initial.getFormattedChat.mockImplementation(async (chat) => ({
    ...formatted,
    prompt: JSON.stringify(chat),
  }));
  h.initial.tokenize.mockImplementation(async (text: string) => ({
    tokens: Array.from({ length: Math.ceil(text.length / 4) }, () => 1),
  }));
  const history: LocalModelMessage[] = [{ role: 'system', content: 'system prompt' }];
  for (let turn = 0; turn < 8; turn += 1) {
    history.push(
      { role: 'user', content: `Old question ${turn}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            id: `call-${turn}`,
            function: { name: 'read_file', arguments: JSON.stringify({ path: `f${turn}.ts` }) },
          },
        ],
      },
      {
        role: 'tool',
        name: 'read_file',
        tool_call_id: `call-${turn}`,
        content: JSON.stringify({
          path: `f${turn}.ts`,
          revision: 'a'.repeat(64),
          content: 'x'.repeat(4000),
        }),
      },
      { role: 'assistant', content: `Answer ${turn}` },
    );
  }
  history.push({ role: 'user', content: 'The current question must survive compaction.' });
  const original = JSON.stringify(history);
  await expect(h.session.generate(history, [], jest.fn())).resolves.toMatchObject({
    content: 'Hello',
  });
  const prompt = h.initial.completion.mock.calls[0]![0].prompt ?? '';
  expect(prompt).toContain('The current question must survive compaction.');
  expect(prompt).not.toContain('x'.repeat(4000));
  expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(
    small.contextTokens - outputReserveTokens(small.contextTokens) - CONTEXT_SAFETY_TOKENS,
  );
  expect(JSON.stringify(history)).toBe(original);
  expect(h.session.snapshot().phase).toBe('ready');
});

test('a native completion failure leaves the healthy resident model ready without a reload', async () => {
  const h = harness();
  await h.session.load(small.id);
  h.initial.completion.mockRejectedValueOnce(new Error('Decode failed'));
  await expect(h.session.generate(messages, [], jest.fn())).rejects.toThrow('Decode failed');
  expect(h.session.snapshot()).toMatchObject({ phase: 'ready', modelId: small.id, error: null });
  await expect(h.session.generate(messages, [], jest.fn())).resolves.toMatchObject({
    content: 'Hello',
  });
  expect(h.loader).toHaveBeenCalledTimes(1);
});

test('stop during a native load returns promptly and releases the context when it arrives', async () => {
  const h = harness();
  const pending = deferred<LocalModelContext>();
  const started = deferred<void>();
  h.loader.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const loading = h.session.load(small.id);
  const interrupted = loading.catch((error: unknown) => error);
  await started.promise;
  expect(h.session.snapshot()).toMatchObject({ phase: 'loading', modelId: small.id });
  await h.session.stop();
  expect(h.session.snapshot().phase).toBe('stopping');
  // A new load queues behind the cancelled native load instead of failing as "changing models".
  const second = context();
  h.loader.mockImplementationOnce(async () => second);
  const next = h.session.load(medium.id);
  pending.resolve(h.initial);
  expect(await interrupted).toBeInstanceOf(LocalModelInterrupted);
  expect(h.initial.release).toHaveBeenCalledTimes(1);
  await next;
  expect(h.session.snapshot()).toMatchObject({ phase: 'ready', modelId: medium.id });
  expect(h.loader).toHaveBeenCalledTimes(2);
});

test('loads use the largest catalog context that fresh headroom admits and expose the resident model', async () => {
  const h = harness();
  h.native.getMemoryInfo.mockReturnValue({
    physicalBytes: 32 * 1024 ** 3,
    availableBytes: modelMemoryBytes(medium, medium.maxContextTokens) - 1,
    isSimulator: false,
  });
  await h.session.load(medium.id);
  expect(h.loader.mock.calls[0]![2]).toMatchObject({ contextTokens: medium.contextTokens });
  expect(h.session.resident()).toEqual({ model: medium, contextTokens: medium.contextTokens });
  await h.session.unload();
  expect(h.session.resident()).toBeNull();
  expect(h.session.snapshot().contextTokens).toBeNull();
});

test('unsupported native tool templates release their context and cannot become ready', async () => {
  const h = harness();
  h.initial.isJinjaSupported.mockReturnValue(false);
  await expect(h.session.load(small.id)).rejects.toThrow('verified native tool format');
  expect(h.initial.release).toHaveBeenCalledTimes(1);
  expect(h.session.snapshot().phase).toBe('error');
});

test('an unverified artifact is refused before allocating any native model', async () => {
  const h = harness();
  h.native.getDownloadedModelFile.mockResolvedValue({
    id: small.id,
    sha256: 'invalid',
    bytes: small.bytes,
    uri: 'file:///invalid',
  });
  await expect(h.session.load(small.id)).rejects.toThrow('Download and verify');
  expect(h.loader).not.toHaveBeenCalled();
});

test('a newer load request supersedes an in-flight one instead of failing as busy', async () => {
  const h = harness();
  const pending = deferred<LocalModelContext>();
  const started = deferred<void>();
  h.loader.mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  const first = h.session.load(small.id);
  expect(h.session.load(small.id)).toBe(first);
  const superseded = first.catch((error: unknown) => error);
  await started.promise;
  const second = context();
  h.loader.mockImplementationOnce(async () => second);
  const latest = h.session.load(medium.id);
  pending.resolve(h.initial);
  expect(await superseded).toBeInstanceOf(LocalModelInterrupted);
  await latest;
  expect(h.initial.release).toHaveBeenCalledTimes(1);
  expect(h.session.snapshot()).toMatchObject({ phase: 'ready', modelId: medium.id });
});
