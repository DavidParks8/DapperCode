import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';
import { localModelDefinition } from './catalog';
import { CONTEXT_SAFETY_TOKENS, OMITTED_TURNS_NOTE, outputReserveTokens } from './contextWindow';
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
import { summaryCharacters } from './summary';

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

const compactionRevision = 'c'.repeat(64);
const historyResult = (index: number) =>
  JSON.stringify({ path: `h${index}.ts`, revision: compactionRevision, content: 'z'.repeat(2000) });
const firstCurrentResult = JSON.stringify({
  path: 'c1.ts',
  revision: compactionRevision,
  content: 'p'.repeat(2000),
});
const lastCurrentResult = JSON.stringify({
  path: 'c2.ts',
  revision: compactionRevision,
  content: 'q'.repeat(2000),
});
const compactionSystem: LocalModelMessage = { role: 'system', content: 'system prompt' };

function historyTurn(index: number): LocalModelMessage[] {
  return [
    { role: 'user', content: `Old question ${index}` },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'thinking',
      tool_calls: [
        {
          type: 'function',
          id: `h-${index}`,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: `h${index}.ts`, content: 'y'.repeat(1000) }),
          },
        },
      ],
    },
    { role: 'tool', name: 'write_file', tool_call_id: `h-${index}`, content: historyResult(index) },
    { role: 'assistant', content: `Answer ${index}` },
  ];
}

function elidedHistoryTurn(index: number): LocalModelMessage[] {
  return [
    { role: 'user', content: `Old question ${index}` },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          type: 'function',
          id: `h-${index}`,
          function: {
            name: 'write_file',
            arguments: `{"path":"h${index}.ts","content":"[1000 characters elided]"}`,
          },
        },
      ],
    },
    {
      role: 'tool',
      name: 'write_file',
      tool_call_id: `h-${index}`,
      content: `{"elided":true,"path":"h${index}.ts","revision":"${compactionRevision}"}`,
    },
    { role: 'assistant', content: `Answer ${index}` },
  ];
}

function currentCall(id: string, path: string): LocalModelMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      { type: 'function', id, function: { name: 'read_file', arguments: `{"path":"${path}"}` } },
    ],
  };
}

const currentTurn: LocalModelMessage[] = [
  { role: 'user', content: 'Current question' },
  currentCall('c-1', 'c1.ts'),
  { role: 'tool', name: 'read_file', tool_call_id: 'c-1', content: firstCurrentResult },
  currentCall('c-2', 'c2.ts'),
  { role: 'tool', name: 'read_file', tool_call_id: 'c-2', content: lastCurrentResult },
];
const elidedFirstCurrentResult: LocalModelMessage = {
  role: 'tool',
  name: 'read_file',
  tool_call_id: 'c-1',
  content: `{"elided":true,"path":"c1.ts","revision":"${compactionRevision}"}`,
};
const compactionConversation = [
  compactionSystem,
  ...historyTurn(0),
  ...historyTurn(1),
  ...historyTurn(2),
  ...currentTurn,
];
const omittedSystem: LocalModelMessage = {
  role: 'system',
  content: `system prompt\n\n${OMITTED_TURNS_NOTE}`,
};

/**
 * Renders each candidate as its JSON and counts tokens with `tokensFor`, so a test chooses
 * exactly which compaction candidate fits.
 */
async function compactionHarness(tokensFor: (prompt: string, limit: number) => number) {
  const h = harness();
  await h.session.load(small.id);
  const contextTokens = h.session.snapshot().contextTokens ?? 0;
  const limit = contextTokens - outputReserveTokens(contextTokens) - CONTEXT_SAFETY_TOKENS;
  h.initial.getFormattedChat.mockImplementation(async (chat) => ({
    ...formatted,
    prompt: JSON.stringify(chat),
  }));
  h.initial.tokenize.mockImplementation(async (text: string) => ({
    tokens: Array.from({ length: tokensFor(text, limit) }, () => 1),
  }));
  const parse = jest.spyOn(JSON, 'parse');
  const parsed = (content: string) => parse.mock.calls.some(([text]) => text === content);
  const chosen = () => {
    parse.mockRestore();
    return JSON.parse(h.initial.completion.mock.calls[0]![0].prompt ?? '') as unknown;
  };
  return { ...h, contextTokens, parse, parsed, chosen };
}

test('a prompt that fits as-is does no elision work on earlier or current tool output', async () => {
  const h = await compactionHarness(() => 1);
  try {
    await h.session.generate(compactionConversation, [], jest.fn());
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(1);
    expect(h.parsed(historyResult(0))).toBe(false);
    expect(h.parsed(historyResult(2))).toBe(false);
    expect(h.parsed(firstCurrentResult)).toBe(false);
    expect(h.parsed(lastCurrentResult)).toBe(false);
    expect(h.chosen()).toEqual(compactionConversation);
  } finally {
    h.parse.mockRestore();
  }
});

test('compaction picks the elided full history when that is the first candidate to fit', async () => {
  const h = await compactionHarness((prompt, limit) =>
    prompt.includes('z'.repeat(2000)) ? limit + 1 : 1,
  );
  try {
    await h.session.generate(compactionConversation, [], jest.fn());
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(2);
    // Current-turn compaction candidates are never built once a history candidate fits.
    expect(h.parsed(firstCurrentResult)).toBe(false);
    expect(h.chosen()).toEqual([
      compactionSystem,
      ...elidedHistoryTurn(0),
      ...elidedHistoryTurn(1),
      ...elidedHistoryTurn(2),
      ...currentTurn,
    ]);
  } finally {
    h.parse.mockRestore();
  }
});

test('compaction drops the oldest turns in doubling steps until the prompt fits', async () => {
  const h = await compactionHarness((prompt, limit) =>
    prompt.includes('Old question 0') || prompt.includes('Old question 1') ? limit + 1 : 1,
  );
  try {
    await h.session.generate(compactionConversation, [], jest.fn());
    // original, elided history, drop 1, drop 2.
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(4);
    expect(h.chosen()).toEqual([omittedSystem, ...elidedHistoryTurn(2), ...currentTurn]);
  } finally {
    h.parse.mockRestore();
  }
});

test('current-turn compaction keeps the latest tool round and elides older ones first', async () => {
  const h = await compactionHarness((prompt, limit) =>
    prompt.includes('p'.repeat(2000)) ? limit + 1 : 1,
  );
  try {
    await h.session.generate(compactionConversation, [], jest.fn());
    // original, elided history, drop 1, drop 2, drop all, current keeping the last round.
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(6);
    expect(h.chosen()).toEqual([
      omittedSystem,
      currentTurn[0],
      currentTurn[1],
      elidedFirstCurrentResult,
      currentTurn[3],
      currentTurn[4],
    ]);
  } finally {
    h.parse.mockRestore();
  }
});

test('the last-resort candidate elides every current-turn tool round', async () => {
  const h = await compactionHarness((prompt, limit) =>
    prompt.includes('p'.repeat(2000)) || prompt.includes('q'.repeat(2000)) ? limit + 1 : 1,
  );
  try {
    await h.session.generate(compactionConversation, [], jest.fn());
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(7);
    expect(h.chosen()).toEqual([
      omittedSystem,
      currentTurn[0],
      currentTurn[1],
      elidedFirstCurrentResult,
      currentTurn[3],
      {
        role: 'tool',
        name: 'read_file',
        tool_call_id: 'c-2',
        content: `{"elided":true,"path":"c2.ts","revision":"${compactionRevision}"}`,
      },
    ]);
  } finally {
    h.parse.mockRestore();
  }
});

test('a history candidate without doubled headroom wins before current output is elided', async () => {
  // Every history candidate fits but leaves less than twice the reserved generation room.
  const h = await compactionHarness((prompt, limit) =>
    prompt.includes('z'.repeat(2000)) ? limit + 1 : limit,
  );
  try {
    await h.session.generate(compactionConversation, [], jest.fn());
    // original plus the four history candidates; the current-turn candidates are never built.
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(5);
    expect(h.parsed(firstCurrentResult)).toBe(false);
    expect(h.parsed(lastCurrentResult)).toBe(false);
    expect(h.chosen()).toEqual([
      compactionSystem,
      ...elidedHistoryTurn(0),
      ...elidedHistoryTurn(1),
      ...elidedHistoryTurn(2),
      ...currentTurn,
    ]);
  } finally {
    h.parse.mockRestore();
  }
});

test('a conversation that fits no candidate still fails as a full context', async () => {
  const h = await compactionHarness((_prompt, limit) => limit + 1);
  try {
    await expect(h.session.generate(compactionConversation, [], jest.fn())).rejects.toBeInstanceOf(
      LocalContextFull,
    );
    expect(h.initial.getFormattedChat).toHaveBeenCalledTimes(7);
    expect(h.initial.completion).not.toHaveBeenCalled();
    expect(h.session.snapshot()).toMatchObject({ phase: 'ready', error: null });
  } finally {
    h.parse.mockRestore();
  }
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

test('summary chunk candidates never split a Unicode code point', async () => {
  const h = await summaryHarness();
  h.transcript[2]!.content = JSON.stringify({ content: '🦙'.repeat(15000) });
  h.initial.getFormattedChat.mockImplementation(async (chat) => {
    for (const message of chat) {
      if (typeof message.content !== 'string') {
        throw new Error('Local summary candidates must contain text only.');
      }
      expect(
        [...message.content].every((character) => {
          const point = character.codePointAt(0) ?? 0;
          return point < 0xd800 || point > 0xdfff;
        }),
      ).toBe(true);
    }
    return { ...formatted, prompt: JSON.stringify(chat) };
  });
  await h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint });
  expect(h.checkpoint.commit).toHaveBeenCalledTimes(1);
});

const currentRequest: LocalModelMessage = {
  role: 'user',
  content: 'Current user request must survive verbatim.',
};

async function summaryHarness(historyCharacters = 14_000) {
  const h = harness();
  await h.session.load(small.id);
  const contextTokens = h.session.snapshot().contextTokens!;
  const threshold = contextTokens - 2 * outputReserveTokens(contextTokens) - CONTEXT_SAFETY_TOKENS;
  // Like the native template, the formatted prompt includes every advertised tool schema.
  h.initial.getFormattedChat.mockImplementation(async (chat, _template, options) => ({
    ...formatted,
    prompt:
      JSON.stringify(chat) +
      (Array.isArray(options?.tools) && options.tools.length ? JSON.stringify(options.tools) : ''),
  }));
  h.initial.tokenize.mockImplementation(async (text) => ({
    tokens: new Array<number>(Math.ceil(text.length / 2)).fill(1),
  }));
  const checkpoint = {
    key: 'earlier-answer',
    previous: 'Earlier decision: preserve user files.',
    started: jest.fn(),
    failed: jest.fn(),
    commit: jest.fn(
      async (content: string, validate: (messages: LocalModelMessage[]) => Promise<void>) => {
        const messages: LocalModelMessage[] = [
          { role: 'system' as const, content: `Coding instructions\nMemory: ${content}` },
          currentRequest,
        ];
        await validate(messages);
        return messages;
      },
    ),
  };
  h.initial.completion.mockResolvedValue({
    ...reply,
    content: 'Observed artifactId abc; completed edits; pending verification.',
  });
  const transcript: LocalModelMessage[] = [
    { role: 'system', content: 'Coding instructions' },
    { role: 'user', content: 'Earlier request to inspect the file.' },
    {
      role: 'tool',
      content: JSON.stringify({
        content: 'x'.repeat(historyCharacters),
        artifactId: 'abc',
        truncated: true,
        revision: 'r',
      }),
    },
    { role: 'assistant', content: 'Earlier answer.' },
    currentRequest,
  ];
  const summaryCalls = () =>
    h.initial.completion.mock.calls.filter(([params]) =>
      params.prompt?.includes('Maintain a concise rolling memory'),
    );
  return { ...h, checkpoint, transcript, threshold, contextTokens, summaryCalls };
}

test('semantic compaction triggers at the real formatted-token threshold before overflow, never below it', async () => {
  const h = await summaryHarness();
  h.initial.tokenize.mockResolvedValueOnce({ tokens: new Array<number>(h.threshold).fill(1) });
  await h.session.generate(h.transcript, [{ tool: 'definitions count too' }], jest.fn(), {
    checkpoint: h.checkpoint,
  });
  expect(h.checkpoint.started).not.toHaveBeenCalled();
  expect(h.checkpoint.commit).not.toHaveBeenCalled();
  h.initial.completion.mockClear();
  await h.session.generate(h.transcript, [{ tool: 'definitions count too' }], jest.fn(), {
    checkpoint: h.checkpoint,
  });
  expect(h.checkpoint.started).toHaveBeenCalledTimes(1);
  expect(h.checkpoint.commit).toHaveBeenCalledTimes(1);
  expect(h.checkpoint.failed).not.toHaveBeenCalled();
  const summaryCall = h.initial.completion.mock.calls[0]![0];
  expect(summaryCall.n_predict).toBeGreaterThan(0);
  expect(summaryCall.n_predict).toBeLessThanOrEqual(
    Math.min(1024, outputReserveTokens(h.contextTokens)),
  );
  // The model is told a memory size derived from the real generation cap.
  expect(summaryCall.prompt).toContain(
    `at most ${String(summaryCharacters(summaryCall.n_predict!))} characters`,
  );
  expect(summaryCall.prompt).toContain('artifactId');
  expect(summaryCall.prompt).toContain('Earlier decision');
  expect(summaryCall.prompt).toContain('Earlier request');
  // The current turn is never summarized; it reaches the model verbatim after compaction.
  expect(summaryCall.prompt).not.toContain('Current user request');
  expect(h.initial.completion.mock.calls.at(-1)?.[0].prompt).toContain(
    'Current user request must survive verbatim.',
  );
});

test('a large fixed prefix with small earlier history never generates a summary', async () => {
  const h = await summaryHarness(400);
  const tools = [{ schema: 's'.repeat(2 * h.threshold) }];
  // The tool schemas alone exceed two generation reserves, but there is little history to shrink.
  await h.session.generate(h.transcript, tools, jest.fn(), { checkpoint: h.checkpoint });
  expect(h.checkpoint.started).not.toHaveBeenCalled();
  expect(h.summaryCalls()).toHaveLength(0);
  expect(h.initial.completion).toHaveBeenCalledTimes(1);
  expect(h.initial.completion.mock.calls[0]![0].prompt).toContain('Earlier request');
});

test('oversized transcripts are fully consumed in multiple native summary rounds, with rolling memory and no tools', async () => {
  const h = await summaryHarness(60_000);
  await h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint });
  const summaryCalls = h.initial.completion.mock.calls.slice(0, -1);
  expect(summaryCalls.length).toBeGreaterThan(1);
  expect(h.checkpoint.commit).toHaveBeenCalledTimes(1);
  expect(summaryCalls[1]?.[0].prompt).toContain('Observed artifactId abc');
  expect(summaryCalls.at(-1)?.[0].prompt).toContain('last');
  const chunks = summaryCalls
    .map(([params]) => {
      const parsed = JSON.parse(params.prompt!) as LocalModelMessage[];
      return parsed[1]!.content.split(/Transcript chunk \((?:last|more follow)\):\n/u)[1];
    })
    .join('');
  expect(chunks).toBe(JSON.stringify(h.transcript.slice(1, -1)));
  expect(
    h.initial.getFormattedChat.mock.calls
      .filter(
        ([chat]) =>
          typeof chat[0]?.content === 'string' &&
          chat[0].content.includes('Maintain a concise rolling memory'),
      )
      .every(
        ([, , options]) =>
          options?.tool_choice === 'none' &&
          Array.isArray(options.tools) &&
          options.tools.length === 0,
      ),
  ).toBe(true);
});

test.each([
  { ...reply, content: '', name: 'empty' },
  { ...reply, content: 'partial summary', truncated: true, name: 'truncated' },
  { ...reply, content: 'partial summary', stopped_limit: 1, name: 'limited' },
])(
  'a $name summary falls back to elision without publishing memory, and is not retried',
  async (invalid) => {
    const h = await summaryHarness();
    h.initial.completion.mockResolvedValueOnce(invalid);
    const original = JSON.stringify(h.transcript);
    await expect(
      h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint }),
    ).resolves.toMatchObject({ content: expect.any(String) });
    expect(h.checkpoint.commit).not.toHaveBeenCalled();
    expect(h.checkpoint.failed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.transcript)).toBe(original);
    expect(h.session.snapshot().phase).toBe('ready');
    const answer = h.initial.completion.mock.calls.at(-1)![0].prompt!;
    expect(answer).not.toContain('Maintain a concise rolling memory');
    expect(answer).toContain('Current user request must survive verbatim.');
    expect(answer).toContain('elided');
    expect(answer).not.toContain('x'.repeat(1000));
    // The same earlier history is not summarized again on the next round.
    h.initial.completion.mockClear();
    await h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint });
    expect(h.checkpoint.started).toHaveBeenCalledTimes(1);
    expect(h.initial.completion).toHaveBeenCalledTimes(1);
  },
);

test('a valid summary whose compacted prompt cannot fit is not committed and falls back to elision', async () => {
  const h = await summaryHarness();
  h.checkpoint.commit.mockImplementationOnce(async (content, validate) => {
    // Saved evidence references or memory can still overflow; validation runs before saving.
    await validate([
      { role: 'system', content: `Memory: ${content}${'r'.repeat(4 * h.contextTokens)}` },
      currentRequest,
    ]);
    return [];
  });
  await expect(
    h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint }),
  ).resolves.toMatchObject({ content: expect.any(String) });
  expect(h.checkpoint.commit).toHaveBeenCalledTimes(1);
  await expect(h.checkpoint.commit.mock.results[0]!.value).rejects.toBeInstanceOf(LocalContextFull);
  expect(h.checkpoint.failed).toHaveBeenCalledTimes(1);
  const answer = h.initial.completion.mock.calls.at(-1)![0].prompt!;
  expect(answer).not.toContain('Memory: ');
  expect(answer).toContain('Current user request must survive verbatim.');
  expect(h.session.snapshot().phase).toBe('ready');
});

test('cancellation during summary generation suppresses late memory and leaves the model ready', async () => {
  const h = await summaryHarness();
  const native = deferred<LocalModelReply>();
  const started = deferred<void>();
  h.initial.completion.mockImplementationOnce(() => {
    started.resolve();
    return native.promise;
  });
  const run = h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint });
  const interrupted = run.catch((error: unknown) => error);
  await started.promise;
  const stop = h.session.stop();
  native.resolve({ ...reply, content: 'Late summary must not publish.' });
  await stop;
  expect(await interrupted).toBeInstanceOf(LocalModelInterrupted);
  expect(h.checkpoint.commit).not.toHaveBeenCalled();
  expect(h.checkpoint.failed).not.toHaveBeenCalled();
  expect(h.initial.completion).toHaveBeenCalledTimes(1);
  expect(h.session.snapshot().phase).toBe('ready');
});

test('a later summary-round error or a checkpoint persistence failure never commits memory; both fall back to elision', async () => {
  const h = await summaryHarness(60_000);
  h.initial.completion
    .mockResolvedValueOnce({ ...reply, content: 'partial memory' })
    .mockRejectedValueOnce(new Error('native failure'))
    .mockResolvedValueOnce({ ...reply, content: 'Answered from elided history.' });
  await expect(
    h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint }),
  ).resolves.toMatchObject({ content: 'Answered from elided history.' });
  expect(h.checkpoint.commit).not.toHaveBeenCalled();
  expect(h.checkpoint.failed).toHaveBeenCalledTimes(1);
  h.initial.completion.mockResolvedValue({ ...reply, content: 'complete memory' });
  h.checkpoint.key = 'a-later-turn';
  h.checkpoint.commit.mockImplementationOnce(async (content, validate) => {
    await validate([{ role: 'system', content: `Memory: ${content}` }, currentRequest]);
    throw new Error('disk full');
  });
  await expect(
    h.session.generate(h.transcript, [], jest.fn(), { checkpoint: h.checkpoint }),
  ).resolves.toMatchObject({ content: 'complete memory' });
  expect(h.checkpoint.failed).toHaveBeenCalledTimes(2);
  const answer = h.initial.completion.mock.calls.at(-1)![0].prompt!;
  expect(answer).not.toContain('Maintain a concise rolling memory');
  expect(answer).not.toContain('Memory: ');
  expect(answer).toContain('Current user request must survive verbatim.');
  expect(h.session.snapshot().phase).toBe('ready');
});
