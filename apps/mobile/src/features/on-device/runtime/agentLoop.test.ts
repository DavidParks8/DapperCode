import { randomUUID } from 'expo-crypto';
import type { LocalModelReply } from '../models/engine';
import { LocalModelInterrupted } from '../models/session';
import type { LocalModelSession } from '../models/session';
import { FILE_TOOL_DEFINITIONS } from '../workspaces/fileToolDefinitions';
import { LocalAgentLoop, type LocalRunSnapshot, type LocalToolExecutor } from './agentLoop';
import { LocalThreadRepository, type LocalDocumentPort } from './threads';
import { parseLocalThread, threadDocument } from './threadCodec';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
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

function response(content: string, names: string[] = []): LocalModelReply {
  return {
    content,
    reasoning_content: '',
    interrupted: false,
    truncated: false,
    stopped_limit: 0,
    tokens_predicted: 5,
    tokens_evaluated: 10,
    tool_calls: names.map((name) => ({
      id: 'provider-reused-id',
      type: 'function',
      function: { name, arguments: JSON.stringify({ path: 'main.txt' }) },
    })),
  };
}

async function harness(contents = new Map<string, string>()) {
  const storage = {
    readRuntimeDocument: jest.fn(async (name: string) => contents.get(name) ?? null),
    writeRuntimeDocument: jest.fn(async (name: string, value: string) => {
      contents.set(name, value);
    }),
    listRuntimeDocuments: jest.fn(async (prefix: string) =>
      [...contents.keys()].filter((key) => key.startsWith(prefix)),
    ),
    removeRuntimeDocument: jest.fn(async (name: string) => {
      contents.delete(name);
    }),
  } satisfies LocalDocumentPort;
  const threads = new LocalThreadRepository(storage, jest.fn());
  await threads.initialize();
  const thread = await threads.create('workspace-fixed', 'qwen3-1.7b-q4-k-m');
  const model = {
    snapshot: jest.fn(() => ({
      phase: 'ready' as const,
      modelId: thread.modelId,
      progress: 100,
      error: null,
    })),
    load: jest.fn(async () => undefined),
    generate: jest.fn<
      ReturnType<LocalModelSession['generate']>,
      Parameters<LocalModelSession['generate']>
    >(async () => response('Finished.')),
    stop: jest.fn(async () => undefined),
  } satisfies Pick<LocalModelSession, 'snapshot' | 'load' | 'generate' | 'stop'>;
  const execute = jest.fn<ReturnType<LocalToolExecutor>, Parameters<LocalToolExecutor>>(
    async () => ({ path: 'main.txt', content: 'actual contents' }),
  );
  const events: LocalRunSnapshot[] = [];
  const loop = new LocalAgentLoop(threads, model, FILE_TOOL_DEFINITIONS, execute, (state) =>
    events.push(state),
  );
  return { contents, storage, threads, thread, model, execute, events, loop };
}

test('real run ordering persists user input and tool intent before executing and consumes JSON results', async () => {
  const h = await harness();
  h.model.generate.mockResolvedValueOnce(response('', ['read_file']));
  h.execute.mockImplementation(async () => {
    const durable: unknown = JSON.parse(h.contents.get(threadDocument(h.thread.id)) ?? 'null');
    expect(durable).toMatchObject({
      status: 'running',
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool: expect.objectContaining({ status: 'pending' }),
        }),
      ]),
    });
    return { path: 'main.txt', content: 'actual contents' };
  });
  const accepted = jest.fn();
  const finished = await h.loop.send(h.thread.id, 'Read main.txt', 'request-one', accepted);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(h.execute).toHaveBeenCalledWith('workspace-fixed', 'read_file', { path: 'main.txt' });
  expect(finished.status).toBe('complete');
  expect(finished.activeTurnId).toBeNull();
  expect(finished.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
  expect(finished.messages[2]).toMatchObject({
    content: JSON.stringify({ path: 'main.txt', content: 'actual contents' }),
    tool: { status: 'completed' },
  });
  expect(h.model.generate.mock.calls[0]?.[0].at(-1)).toMatchObject({
    role: 'user',
    content: 'Read main.txt',
  });
  expect(h.model.generate.mock.calls[1]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: JSON.stringify({ path: 'main.txt', content: 'actual contents' }),
      }),
    ]),
  );
  expect(h.events.map((state) => state.phase)).toEqual([
    'preparing',
    'generating',
    'tool',
    'generating',
    'persisting',
    'idle',
  ]);
});

test('stopping an in-flight edit waits for its result, preserves the completed edit, and starts no next model round', async () => {
  const h = await harness();
  h.model.generate.mockResolvedValueOnce(response('', ['edit_file']));
  const started = deferred<void>();
  const tool = deferred<unknown>();
  h.execute.mockImplementation(() => {
    started.resolve();
    return tool.promise;
  });
  const running = h.loop.send(h.thread.id, 'Edit the file', 'request-one');
  await started.promise;
  const stopped = h.loop.stop();
  expect(h.loop.snapshot().phase).toBe('stopping');
  expect(h.threads.get(h.thread.id).status).toBe('running');
  tool.resolve({ revision: 'updated' });
  await stopped;
  const settled = await running;
  expect(settled.status).toBe('interrupted');
  expect(settled.activeTurnId).toBeNull();
  expect(settled.messages.find((message) => message.role === 'tool')).toMatchObject({
    tool: { status: 'completed' },
    content: JSON.stringify({ revision: 'updated' }),
  });
  expect(h.model.generate).toHaveBeenCalledTimes(1);
  expect(h.loop.snapshot().phase).toBe('idle');
});

test('stop during generation preserves partial output and fences callbacks after settlement', async () => {
  const h = await harness();
  const generated = deferred<LocalModelReply>();
  const started = deferred<void>();
  let update: Parameters<LocalModelSession['generate']>[2] | undefined;
  h.model.generate.mockImplementation((_messages, _tools, callback) => {
    update = callback;
    callback({ content: 'Partial response', reasoning: '' });
    started.resolve();
    return generated.promise;
  });
  h.model.stop.mockImplementation(async () => {
    generated.reject(new LocalModelInterrupted());
  });
  const running = h.loop.send(h.thread.id, 'Explain', 'request-one');
  await started.promise;
  await h.loop.stop();
  const settled = await running;
  expect(settled.status).toBe('interrupted');
  expect(settled.messages.at(-1)?.content).toBe('Partial response');
  update?.({ content: 'Late response', reasoning: '' });
  expect(h.threads.get(h.thread.id).messages.at(-1)?.content).toBe('Partial response');
  expect(h.loop.snapshot().phase).toBe('idle');
});

test('recovery never replays pending edits and supplies results for unadmitted tool calls', async () => {
  const h = await harness();
  h.model.generate.mockResolvedValueOnce(response('', ['write_file', 'read_file']));
  const started = deferred<void>();
  const pending = deferred<unknown>();
  h.execute.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const running = h.loop.send(h.thread.id, 'Change files', 'request-one');
  await started.promise;
  const snapshot = new Map(h.contents);
  const recoveredStorage = {
    ...h.storage,
    readRuntimeDocument: async (name: string) => snapshot.get(name) ?? null,
    writeRuntimeDocument: async (name: string, value: string) => {
      snapshot.set(name, value);
    },
    listRuntimeDocuments: async (prefix: string) =>
      [...snapshot.keys()].filter((key) => key.startsWith(prefix)),
  };
  const restored = new LocalThreadRepository(recoveredStorage, jest.fn());
  await restored.initialize();
  const recovered = restored.get(h.thread.id);
  expect(recovered.status).toBe('interrupted');
  expect(recovered.activeTurnId).toBeNull();
  expect(recovered.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
  expect(
    recovered.messages
      .filter((message) => message.tool)
      .every((message) => message.tool?.status === 'interrupted'),
  ).toBe(true);
  expect(h.execute).toHaveBeenCalledTimes(1);
  const stopping = h.loop.stop();
  pending.resolve({ result: 'settled after test snapshot' });
  await stopping;
  await running;
});

test('old duplicate submissions remain idempotent after newer successful messages', async () => {
  const h = await harness();
  await h.loop.send(h.thread.id, 'First', 'request-one');
  await h.loop.send(h.thread.id, 'Second', 'request-two');
  await h.loop.send(h.thread.id, 'First', 'request-one');
  expect(
    h.threads.get(h.thread.id).messages.filter((message) => message.role === 'user'),
  ).toHaveLength(2);
  expect(h.model.generate).toHaveBeenCalledTimes(2);
});

test('a tool cannot execute if its durable intent write fails', async () => {
  const h = await harness();
  h.model.generate.mockResolvedValueOnce(response('', ['write_file']));
  h.storage.writeRuntimeDocument.mockImplementation(async (name, value) => {
    const thread = parseLocalThread(value, h.thread.id);
    if (thread.messages.some((message) => message.tool?.status === 'pending')) {
      throw new Error('Intent persistence failed.');
    }
    h.contents.set(name, value);
  });
  await expect(h.loop.send(h.thread.id, 'Write', 'request-one')).rejects.toThrow(
    'Intent persistence failed.',
  );
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.threads.get(h.thread.id).status).toBe('failed');
  expect(h.loop.snapshot().phase).toBe('idle');
});

test('tool budgets settle visibly and give every unexecuted call an interrupted result', async () => {
  const h = await harness();
  h.model.generate.mockResolvedValueOnce(
    response(
      '',
      Array.from({ length: 33 }, () => 'read_file'),
    ),
  );
  const settled = await h.loop.send(h.thread.id, 'Inspect', 'request-one');
  expect(h.execute).toHaveBeenCalledTimes(32);
  expect(settled.status).toBe('interrupted');
  expect(settled.lastError).toContain('tool limit');
  const results = settled.messages.filter((message) => message.role === 'tool');
  expect(results).toHaveLength(33);
  expect(results.filter((message) => message.tool?.status === 'interrupted')).toHaveLength(1);
  expect(new Set(results.map((message) => message.tool?.callId)).size).toBe(33);
});

test('a thread cannot change the workspace captured by an active run', async () => {
  const h = await harness();
  h.model.generate.mockImplementationOnce(async () => {
    h.threads.change(h.thread.id, (thread) => ({ ...thread, workspaceId: 'different-workspace' }));
    return response('', ['read_file']);
  });
  await h.loop.send(h.thread.id, 'Inspect', 'request-one');
  expect(h.execute.mock.calls[0]?.[0]).toBe('workspace-fixed');
});
