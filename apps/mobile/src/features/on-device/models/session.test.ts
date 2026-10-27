import type { CompletionParams, FormattedChatResult, TokenData } from 'llama.rn';
import { localModelDefinition } from './catalog';
import type { LocalContextLoader, LocalModelContext, LocalModelReply } from './engine';
import { modelFileSystemPath } from './engine';
import { MODEL_MEMORY_RESERVE_BYTES, modelMemoryBytes } from './memory';
import {
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
    getFormattedChat: jest.fn(async () => formatted),
    tokenize: jest.fn(async () => ({ tokens: [1, 2, 3] })),
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
  await expect(h.session.load(small.id)).rejects.toThrow('unavailable');
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

test('prompt budgets refuse truncation at the exact context threshold', async () => {
  const h = harness();
  await h.session.load(small.id);
  const limit = small.contextTokens - 512 - 32;
  h.initial.tokenize.mockResolvedValue({ tokens: Array.from({ length: limit }, () => 1) });
  await h.session.generate(messages, [], jest.fn());
  h.initial.tokenize.mockResolvedValue({ tokens: Array.from({ length: limit + 1 }, () => 1) });
  await expect(h.session.generate(messages, [], jest.fn())).rejects.toThrow(
    'context window is full',
  );
  expect(h.initial.completion).toHaveBeenCalledTimes(1);
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
