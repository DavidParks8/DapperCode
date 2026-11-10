import { randomUUID as uuid } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'expo-crypto';
import type { LocalModelContext, LocalModelMessage, LocalModelReply } from '../models/engine';
import { localModelDefinition } from '../models/catalog';
import { modelMemoryBytes } from '../models/memory';
import { LocalModelSession } from '../models/session';
import { LocalAgentLoop, type LocalRunSnapshot } from './agentLoop';
import { LOCAL_TOOL_DEFINITIONS, localToolApproval } from './localTools';
import { LocalThreadRepository, type LocalDocumentPort } from './threads';
import { localAgentStatus } from './status';
import type { LocalMessage } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
beforeEach(() => jest.mocked(randomUUID).mockImplementation(uuid));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function answer(content: string, name?: string, args: object = {}): LocalModelReply {
  return {
    content,
    reasoning_content: '',
    interrupted: false,
    truncated: false,
    stopped_limit: 0,
    tokens_predicted: 1,
    tokens_evaluated: 1,
    tool_calls: name
      ? [{ id: uuid(), type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      : [],
  };
}

test('an oversized summary is not committed; the turn falls back to elision and a later turn commits memory', async () => {
  const h = await setup();
  const earlier = {
    id: uuid(),
    role: 'user' as const,
    content: 'x'.repeat(8000),
    createdAt: new Date().toISOString(),
  };
  h.threads.change(h.thread.id, (thread) => ({ ...thread, messages: [earlier] }));
  h.control.summaryContent = 'M'.repeat(12000);
  const fallback = await h.loop.send(h.thread.id, 'Continue', uuid());
  expect(fallback).toMatchObject({ status: 'complete', lastError: null });
  expect(fallback.contextSummary).toBeUndefined();
  expect(fallback.messages[0]).toEqual(earlier);
  expect(h.summaries).toHaveLength(1);
  const answer = h.prompts.at(-1)!;
  // The pre-memory prompt still fits with one generation reserve, so it runs unchanged.
  expect(answer[0]?.content).not.toContain('Rolling conversation memory');
  expect(answer.slice(1).map((message) => message.content)).toEqual([earlier.content, 'Continue']);
  expect(h.events.map((event) => event.phase)).toEqual(
    expect.arrayContaining(['compacting', 'generating']),
  );
  expect(h.execute).not.toHaveBeenCalled();
  h.control.summaryContent = '';
  await h.loop.send(h.thread.id, 'Continue with a small step', uuid());
  expect(h.threads.get(h.thread.id).status).toBe('complete');
  expect(h.threads.get(h.thread.id).contextSummary?.content).toContain(
    'Pending: inspect tail evidence',
  );
  expect(h.execute).not.toHaveBeenCalled();
});

async function setup() {
  const root = path.join(
    process.env['ON_DEVICE_CONTEXT_TEST_ROOT'] ?? path.join(process.cwd(), '.context-test-data'),
    uuid(),
  );
  mkdirSync(root, { recursive: true });
  const storage: LocalDocumentPort = {
    readRuntimeDocument: (name) => {
      try {
        return Promise.resolve(readFileSync(path.join(root, name), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return Promise.resolve(null);
        }
        return Promise.reject(error instanceof Error ? error : new Error('Document read failed.'));
      }
    },
    writeRuntimeDocument: (name, value) => {
      writeFileSync(path.join(root, name), value);
      return Promise.resolve();
    },
    listRuntimeDocuments: (prefix) =>
      Promise.resolve(readdirSync(root).filter((name) => name.startsWith(prefix))),
    removeRuntimeDocument: (name) => {
      try {
        unlinkSync(path.join(root, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return Promise.reject(
            error instanceof Error ? error : new Error('Document removal failed.'),
          );
        }
      }
      return Promise.resolve();
    },
  };
  const threads = new LocalThreadRepository(storage, jest.fn(), 60_000);
  await threads.initialize();
  const thread = await threads.create('workspace-owned', 'qwen3-0.6b-q4-0');
  const prompts: LocalModelMessage[][] = [];
  const budgets: number[] = [];
  const summaries: string[] = [];
  const normalReplies: LocalModelReply[] = [];
  let releaseSummary: (() => void) | null = null;
  const control = {
    holdSummary: false,
    failSummary: false,
    summaryContent: '',
    release: () => releaseSummary?.(),
  };
  const context: LocalModelContext = {
    getFormattedChat: (messages) =>
      Promise.resolve({ type: 'jinja', prompt: JSON.stringify(messages), has_media: false }),
    tokenize: (content) =>
      Promise.resolve({ tokens: new Array<number>(Math.ceil(content.length / 2)).fill(1) }),
    completion: async (params) => {
      const messages = JSON.parse(params.prompt!) as LocalModelMessage[];
      prompts.push(messages);
      budgets.push(params.n_predict!);
      if (messages[0]?.content.includes('Maintain a concise rolling memory')) {
        summaries.push(messages[1]!.content);
        if (control.holdSummary) {
          await new Promise<void>((resolve) => {
            releaseSummary = resolve;
          });
        }
        if (control.failSummary) {
          throw new Error('inference failed during semantic summary');
        }
        const refs = readdirSync(root)
          .filter((name) => name.startsWith('toolartifact-'))
          .map(
            (name) =>
              (JSON.parse(readFileSync(path.join(root, name), 'utf8')) as { artifactId: string })
                .artifactId,
          );
        return answer(
          control.summaryContent ||
            `Request: continue verification. Decision: preserve files. Completed write_file; do not replay. Observed revision ${'a'.repeat(64)}; artifactId ${refs.join(',')}; producer truncated=true. Pending: inspect tail evidence.`,
        );
      }

      return normalReplies.shift() ?? answer('Verified; no mutation replayed.');
    },
    stopCompletion: () => {
      releaseSummary?.();
      releaseSummary = null;
      return Promise.resolve();
    },
    release: () => Promise.resolve(),
    isJinjaSupported: () => true,
  };
  const native = {
    getMemoryInfo: () => ({
      physicalBytes: 32 * 1024 ** 3,
      availableBytes: modelMemoryBytes(localModelDefinition('qwen3-0.6b-q4-0'), 8192),
      isSimulator: true,
    }),
    getDownloadedModelFile: (id: string) => {
      const model = localModelDefinition(id);
      return Promise.resolve({
        id,
        bytes: model.bytes,
        sha256: model.sha256,
        uri: 'file:///test-model.gguf',
      });
    },
  };
  const model = new LocalModelSession(native, () => Promise.resolve(context), jest.fn());
  const execute = jest.fn(() =>
    Promise.resolve({
      path: 'file.ts',
      revision: 'a'.repeat(64),
      content: `${'observed evidence '.repeat(1000)}TAIL-EVIDENCE`,
      truncated: true,
      nextOffset: 50000,
    }),
  );
  const events: LocalRunSnapshot[] = [];
  const loop = new LocalAgentLoop(
    threads,
    model,
    LOCAL_TOOL_DEFINITIONS,
    execute,
    (state) => events.push(state),
    localToolApproval,
  );
  cleanups.push(async () => {
    threads.close();
    await model.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  function growHistory() {
    const history: LocalMessage[] = Array.from({ length: 24 }, (_, index) => ({
      id: uuid(),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Historical decision ${index}: ${'observed evidence '.repeat(150)}`,
      createdAt: new Date().toISOString(),
    }));
    threads.change(thread.id, (current) => ({
      ...current,
      messages: [...current.messages, ...history],
    }));
  }
  return {
    root,
    storage,
    threads,
    thread,
    model,
    execute,
    loop,
    prompts,
    budgets,
    summaries,
    normalReplies,
    control,
    growHistory,
    events,
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('The local inference transition did not occur.');
}

test('real loop/model/repository preserve evidence across multi-round summary, retrieval, disk reload and deletion', async () => {
  const h = await setup();
  h.normalReplies.push(
    answer('', 'write_file', { path: 'file.ts', content: 'requested change' }),
    answer('Edit completed.'),
  );
  await h.loop.send(h.thread.id, 'Make the requested change.', 'first');
  await h.threads.flush();
  const result = JSON.parse(
    h.threads.get(h.thread.id).messages.find((message) => message.role === 'tool')!.content,
  ) as { artifactId: string };
  expect(result).toMatchObject({ offloaded: true, truncated: true, nextOffset: 50000 });
  h.growHistory();
  const original = [...h.threads.get(h.thread.id).messages];
  h.normalReplies.push(
    answer('', 'search_tool_output', { artifactId: result.artifactId, query: 'TAIL-EVIDENCE' }),
  );
  const finished = await h.loop.send(
    h.thread.id,
    'Continue verification; retain this exact request.',
    'second',
  );
  await h.threads.flush();
  expect(h.summaries.length).toBeGreaterThan(1);
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(finished.contextSummary?.content).toContain(result.artifactId);
  expect(finished.contextSummary?.content).toContain('do not replay');
  expect(finished.messages.slice(0, original.length)).toEqual(original);
  expect(finished.messages.at(-2)?.content).toContain('TAIL-EVIDENCE');
  expect(finished.status).toBe('complete');
  expect(h.loop.snapshot().phase).toBe('idle');
  const compactedPrompt = h.prompts.find((messages) =>
    messages[0]?.content.includes('Rolling conversation memory'),
  );
  expect(
    compactedPrompt?.some(
      (message) =>
        message.role === 'user' &&
        message.content === 'Continue verification; retain this exact request.',
    ),
  ).toBe(true);
  expect(h.events.map((event) => event.phase)).toContain('compacting');
  expect(h.budgets.every((budget) => budget > 0)).toBe(true);
  h.threads.close();
  const reloaded = new LocalThreadRepository(h.storage, jest.fn());
  await reloaded.initialize();
  cleanups.push(() => {
    reloaded.close();
    return Promise.resolve();
  });
  expect(reloaded.get(h.thread.id).contextSummary).toEqual(finished.contextSummary);
  expect(reloaded.get(h.thread.id).messages).toEqual(finished.messages);
  await expect(
    reloaded.artifacts.retrieve(h.thread.id, h.thread.workspaceId, 'search_tool_output', {
      artifactId: result.artifactId,
      query: 'TAIL-EVIDENCE',
    }),
  ).resolves.toMatchObject({
    matches: expect.arrayContaining([
      expect.objectContaining({ excerpt: expect.stringContaining('TAIL-EVIDENCE') }),
    ]),
  });
  await reloaded.remove(h.thread.id);
  expect(readdirSync(h.root)).toEqual([]);
});

test('checkpoint write failure preserves previous durable memory and original history; the turn falls back to elision', async () => {
  const h = await setup();
  await h.loop.send(h.thread.id, 'Start.', 'first');
  const previous = {
    content: 'Earlier durable decision.',
    throughMessageId: h.threads.get(h.thread.id).messages.at(-1)!.id,
    modelId: h.thread.modelId,
    createdAt: new Date().toISOString(),
  };
  h.threads.change(h.thread.id, (thread) => ({ ...thread, contextSummary: previous }));
  await h.threads.save(h.thread.id);
  h.growHistory();
  const original = [...h.threads.get(h.thread.id).messages];
  const write = h.storage.writeRuntimeDocument;
  h.storage.writeRuntimeDocument = (name, value) =>
    value.includes('Observed revision')
      ? Promise.reject(new Error('checkpoint disk full'))
      : write(name, value);
  await expect(h.loop.send(h.thread.id, 'Continue.', 'second')).resolves.toMatchObject({
    status: 'complete',
    lastError: null,
  });
  expect(h.summaries).not.toHaveLength(0);
  expect(h.prompts.at(-1)?.at(-1)?.content).toBe('Continue.');
  expect(h.threads.get(h.thread.id).contextSummary).toEqual(previous);
  expect(h.threads.get(h.thread.id).messages.slice(0, original.length)).toEqual(original);
  await h.threads.flush();
  h.threads.close();
  const restored = new LocalThreadRepository(h.storage, jest.fn());
  await restored.initialize();
  cleanups.push(() => {
    restored.close();
    return Promise.resolve();
  });
  expect(restored.get(h.thread.id).contextSummary).toEqual(previous);
  expect(restored.get(h.thread.id).status).toBe('complete');
});

test('summary stop preserves history and settled controls; retry never replays a completed mutation', async () => {
  const h = await setup();
  h.normalReplies.push(
    answer('', 'write_file', { path: 'file.ts', content: 'requested change' }),
    answer('Edit completed.'),
  );
  await h.loop.send(h.thread.id, 'Make the change.', 'first');
  h.growHistory();
  const original = [...h.threads.get(h.thread.id).messages];
  h.control.holdSummary = true;
  const running = h.loop.send(h.thread.id, 'Continue verification.', 'second');
  const outcome = running.catch((error: unknown) => error);
  await until(() => h.loop.snapshot().phase === 'compacting');
  expect(
    localAgentStatus({
      run: h.loop.snapshot(),
      model: h.model.snapshot(),
      thread: h.threads.get(h.thread.id),
      modelId: h.thread.modelId,
      download: { phase: 'ready', bytesWritten: 0 },
    }),
  ).toMatchObject({ kind: 'busy', label: 'Summarizing conversation on this iPhone' });
  await h.loop.stop();
  await outcome;
  const settled = h.threads.get(h.thread.id);
  expect(settled.status).toBe('interrupted');
  expect(settled.activeTurnId).toBeNull();
  expect(settled.contextSummary).toBeUndefined();
  expect(settled.messages.slice(0, original.length)).toEqual(original);
  expect(settled.messages.at(-1)?.content).toBe('Continue verification.');
  expect(h.loop.snapshot()).toMatchObject({ phase: 'idle', approval: null, toolName: null });
  h.control.holdSummary = false;
  const retried = await h.loop.retry(h.thread.id);
  expect(retried.status).toBe('complete');
  expect(retried.contextSummary).toBeDefined();
  expect(
    retried.messages.filter(
      (message) => message.role === 'user' && message.content === 'Continue verification.',
    ),
  ).toHaveLength(1);
  expect(h.execute).toHaveBeenCalledTimes(1);
  await h.threads.flush();
});

test('a summary inference error falls back to elision without memory; the next turn summarizes and never replays a mutation', async () => {
  const h = await setup();
  h.normalReplies.push(
    answer('', 'write_file', { path: 'file.ts', content: 'requested change' }),
    answer('Edit completed.'),
  );
  await h.loop.send(h.thread.id, 'Make the change.', 'first');
  h.growHistory();
  const original = [...h.threads.get(h.thread.id).messages];
  h.control.failSummary = true;
  const fallback = await h.loop.send(h.thread.id, 'Continue verification.', 'second');
  expect(fallback).toMatchObject({ status: 'complete', lastError: null, activeTurnId: null });
  expect(fallback.contextSummary).toBeUndefined();
  expect(fallback.messages.slice(0, original.length)).toEqual(original);
  expect(h.prompts.at(-1)?.at(-1)?.content).toContain('Continue verification.');
  expect(h.loop.snapshot()).toMatchObject({ phase: 'idle', approval: null, toolName: null });
  h.control.failSummary = false;
  const next = await h.loop.send(h.thread.id, 'Continue once more.', 'third');
  expect(next.status).toBe('complete');
  expect(next.contextSummary).toBeDefined();
  expect(h.execute).toHaveBeenCalledTimes(1);
  await h.threads.flush();
});
