import { EventType } from '@ag-ui/core';

import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import { RUN_ACTIVITY_EVENT_NAME, type RunActivity } from '@bridge/runActivity';
import { localModelDefinition } from '../models/catalog';
import { outputReserveTokens } from '../models/contextWindow';
import type { LocalContextLoader } from '../models/engine';
import { modelMemoryAdmission, modelMemoryBytes } from '../models/memory';
import { OnDeviceRuntime } from '../runtime/runtime';
import {
  createFakeOnDeviceNative,
  FakeLlama,
  FakeNetwork,
  type FakeNativeOptions,
} from '../runtime/testing';
import type { LocalNotification } from './events';
import { createRuntimeAgentPort } from './runtimePort';
import { LocalBridgeServer } from './server';
import { LOCAL_WORKSPACE_ROOT } from './wire';
import { FakeAgentPort } from './testing';
import { LOCAL_TURN_RETRY_METHOD } from './server';

jest.mock('expo-crypto', () => {
  let counter = 0;
  return {
    randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  };
});

let mockLlama = new FakeLlama();
jest.mock('../models/engine', () => ({
  ...jest.requireActual<object>('../models/engine'),
  loadNativeModelContext: (...args: Parameters<LocalContextLoader>) => mockLlama.loader(...args),
}));

const QWEN = 'qwen3-1.7b-q4-k-m';
const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

const runtimes: OnDeviceRuntime[] = [];

afterEach(async () => {
  mockLlama.holdLoads = false;
  mockLlama.holdCompletions = false;
  mockLlama.finishLoad();
  mockLlama.finishCompletion();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function tick(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The real runtime, port, and server over in-memory native services and a scripted model. */
async function setup(options: FakeNativeOptions = {}) {
  mockLlama = new FakeLlama();
  const fake = createFakeOnDeviceNative(mockLlama, { downloaded: [QWEN], ...options });
  const runtime = new OnDeviceRuntime(fake.native, {
    network: new FakeNetwork(),
    emitIntervalMs: 0,
    threadProgressDelayMs: 0,
  });
  runtimes.push(runtime);
  await runtime.initialize();
  const server = new LocalBridgeServer(createRuntimeAgentPort(runtime));
  const notifications: LocalNotification[] = [];
  server.onNotification((notification) => notifications.push(notification));
  server.start();
  const events = () =>
    notifications
      .map((notification) => parseAgUiEventNotification(notification))
      .filter((envelope) => envelope !== null)
      .map((envelope) => envelope.event);
  const activities = () =>
    events()
      .filter((event) => event.type === EventType.CUSTOM && event.name === RUN_ACTIVITY_EVENT_NAME)
      .map((event) => {
        const value = (event as { value: { title: string; detail?: string } }).value;
        return value.detail ? `${value.title} · ${value.detail}` : value.title;
      });
  const createChat = async (model = QWEN) => {
    const response = (await server.request('bridge/thread/create', {
      submissionId: `create-${String(notifications.length)}`,
      threadStart: { cwd: DEMO, model },
    })) as { thread: { id: string } };
    return response.thread.id;
  };
  const send = (threadId: string, content: string, submissionId = `submit-${content}`) =>
    server.request('bridge/thread/queue/send', { threadId, submissionId, content, turnStart: {} });
  return { fake, runtime, server, notifications, events, activities, createChat, send };
}

interface ObservedEvent {
  type: EventType;
  name?: string;
  value?: unknown;
}

/** Activity titles with consecutive repeats (load percentages) collapsed. */
function phases(events: readonly ObservedEvent[]): string[] {
  return events
    .filter((event) => event.type === EventType.CUSTOM && event.name === RUN_ACTIVITY_EVENT_NAME)
    .map((event) => (event.value as RunActivity).title)
    .filter((title, index, titles) => title !== titles[index - 1]);
}

/** The run lifecycle events (not activity or tool metadata), in order. */
function lifecycle(events: readonly ObservedEvent[]): EventType[] {
  return events.map((event) => event.type).filter((type) => type !== EventType.CUSTOM);
}

describe('the local transport over the real on-device runtime', () => {
  it('forwards native Git transfer progress events and releases the native listener on stop', async () => {
    const { fake, server, notifications } = await setup();
    expect(fake.gitProgressListeners.size).toBe(1);

    fake.emitGitTransferProgress({ active: true, cancelled: false, completed: 12, total: 48 });
    expect(
      notifications.filter(
        (notification) => notification.method === 'workspace/clone/progressChanged',
      ),
    ).toEqual([
      {
        method: 'workspace/clone/progressChanged',
        params: { active: true, cancelled: false, completed: 12, total: 48 },
      },
    ]);

    server.stop();
    expect(fake.gitProgressListeners.size).toBe(0);
  });

  it('reports load progress before the run starts and records the message only after the load', async () => {
    const { runtime, events, activities, createChat, send } = await setup();
    const threadId = await createChat();
    mockLlama.holdLoads = true;
    mockLlama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] },
      { content: 'It says hello.' },
    );
    const sent = send(threadId, 'Read the README');
    await until(() => mockLlama.loadPending, 'the model load');
    mockLlama.loadProgress(42);
    await tick();

    // Nothing is recorded and no run exists while the model loads; only its progress is reported.
    expect(runtime.threads.get(threadId)).toMatchObject({ status: 'idle', messages: [] });
    expect(lifecycle(events())).toEqual([]);
    expect(activities()).toContain('Loading Qwen3 1.7B · 42%');

    mockLlama.finishLoad();
    await sent;
    await until(() => runtime.threads.get(threadId).status === 'complete', 'the turn to settle');
    expect(runtime.threads.get(threadId).messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(phases(events())).toEqual([
      'Preparing',
      'Loading Qwen3 1.7B',
      'Preparing',
      'Generating',
      'Reading README.md',
      'Generating',
      'Saving',
    ]);
    expect(lifecycle(events())).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it('is mirrored by the FakeAgentPort used by shell tests, phase for phase', async () => {
    // The same turn, scripted through the fake the way the shell tests drive it.
    const port = new FakeAgentPort();
    const server = new LocalBridgeServer(port);
    const notifications: LocalNotification[] = [];
    server.onNotification((notification) => notifications.push(notification));
    server.start();
    const response = (await server.request('bridge/thread/create', {
      submissionId: 'create-1',
      threadStart: { cwd: DEMO, model: QWEN },
    })) as { thread: { id: string } };
    const threadId = response.thread.id;
    port.holdModelLoad = true;
    const sent = server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Read the README',
      turnStart: {},
    });
    await tick();
    expect(port.thread(threadId)).toMatchObject({ status: 'idle', messages: [] });
    port.setModel({ phase: 'loading', modelId: QWEN, progress: 0 });
    port.setModel({ progress: 42 });
    port.setModel({ phase: 'ready', progress: 100 });
    port.finishModelLoad();
    await sent;
    port.streamAssistant(threadId, 'assistant-1', '');
    port.startTool(threadId, 'assistant-1', 'call-1', 'read_file', '{"path":"README.md"}');
    port.finishTool(threadId, 'call-1', '{"content":"hello"}', 'completed');
    port.streamAssistant(threadId, 'assistant-2', 'It says hello.');
    port.settle(threadId, 'complete');
    const fake = notifications
      .map((notification) => parseAgUiEventNotification(notification))
      .filter((envelope) => envelope !== null)
      .map((envelope) => envelope.event);

    const real = await setup();
    const realThread = await real.createChat();
    mockLlama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] },
      { content: 'It says hello.' },
    );
    await real.send(realThread, 'Read the README');
    await until(() => real.runtime.threads.get(realThread).status === 'complete', 'the real turn');

    expect(phases(fake)).toEqual(phases(real.events()));
    expect(lifecycle(fake)).toEqual(lifecycle(real.events()));
  });

  it('stops a turn while the model loads without recording it, and releases the late context', async () => {
    const { runtime, server, events, activities, createChat, send } = await setup();
    const threadId = await createChat();
    mockLlama.holdLoads = true;
    const sent = send(threadId, 'Explain the workspace');
    await until(() => mockLlama.loadPending, 'the model load');
    mockLlama.loadProgress(10);
    await tick();

    await server.request('turn/interrupt', { threadId });
    await sent;
    expect(activities()).toContain('Cancelling model load');
    expect(runtime.threads.get(threadId)).toMatchObject({ status: 'idle', messages: [] });
    expect(lifecycle(events())).toEqual([]);

    // The native load returns after the stop; its context is released at once.
    mockLlama.finishLoad();
    await until(() => mockLlama.resident.size === 0 && mockLlama.releases === 1, 'the release');
    expect(runtime.models.snapshot().phase).toBe('empty');

    mockLlama.holdLoads = false;
    await send(threadId, 'Explain the workspace', 'submit-again');
    await until(() => runtime.threads.get(threadId).status === 'complete', 'the resent turn');
    expect(runtime.threads.get(threadId).messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('keeps a failed load out of history so the draft can be resent', async () => {
    const { runtime, events, createChat, send } = await setup();
    const threadId = await createChat();
    mockLlama.holdLoads = true;
    const sent = send(threadId, 'Explain the workspace');
    await until(() => mockLlama.loadPending, 'the model load');
    mockLlama.failLoad('Not enough memory to load Qwen3 1.7B.');

    await expect(sent).rejects.toThrow('Not enough memory to load Qwen3 1.7B.');
    expect(runtime.threads.get(threadId)).toMatchObject({
      status: 'idle',
      messages: [],
      lastError: 'Not enough memory to load Qwen3 1.7B.',
    });
    expect(lifecycle(events())).toEqual([]);
  });

  it('retries a failed turn in place without reloading the model, resending, or replaying tools', async () => {
    const { fake, runtime, server, events, createChat, send } = await setup({
      files: { 'ws-one:README.md': '# Demo\n' },
    });
    const threadId = await createChat();
    mockLlama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] },
      { fail: 'The native generation failed.' },
    );
    await send(threadId, 'Summarize the README');
    await until(() => runtime.threads.get(threadId).status === 'failed', 'the failure');
    expect(events().at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
    // A generation failure leaves the resident model ready instead of forcing a reload.
    expect(runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId: QWEN });
    const { thread: failed } = (await server.request('thread/read', {
      threadId,
      includeTurns: true,
    })) as { thread: { turns: { status: string; error?: { message: string } }[] } };
    expect(failed.turns.at(-1)).toMatchObject({
      status: 'failed',
      error: { message: 'The native generation failed.' },
    });

    mockLlama.reply({ content: 'The README introduces Demo.' });
    await server.request(LOCAL_TURN_RETRY_METHOD, { threadId });
    await until(() => runtime.threads.get(threadId).status === 'complete', 'the retried turn');
    const thread = runtime.threads.get(threadId);
    expect(thread.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(thread.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(thread.messages.at(-1)).toMatchObject({ content: 'The README introduces Demo.' });
    expect(thread.lastError).toBeNull();
    expect(fake.calls.filter((call) => call.startsWith('readWorkspaceFile'))).toHaveLength(1);
    expect(mockLlama.loads).toHaveLength(1);
    expect(events().at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  it.each([
    ['reject-once', false],
    ['allow-once', true],
  ] as const)('asks before a model-initiated push and honours %s', async (decision, approved) => {
    const { fake, runtime, server, notifications, createChat, send } = await setup();
    const threadId = await createChat();
    mockLlama.reply(
      { toolCalls: [{ name: 'git_push', arguments: {} }] },
      { content: approved ? 'Pushed.' : 'Left it unpushed.' },
    );
    const sent = send(threadId, 'Push my branch');
    await until(
      () => notifications.some((entry) => entry.method === 'bridge/approval.requested'),
      'the approval request',
    );
    expect(runtime.loop.snapshot().phase).toBe('approval');
    expect(fake.calls).not.toContain('pushWorkspaceGit:["ws-one"]');
    const [approval] = (await server.request('bridge/approvals/list')) as { requestId: string }[];

    await server.request('bridge/approvals/resolve', { id: approval?.requestId, decision });
    await sent;
    await until(() => runtime.threads.get(threadId).status === 'complete', 'the turn');
    expect(fake.calls.includes('pushWorkspaceGit:["ws-one"]')).toBe(approved);
    const tool = runtime.threads.get(threadId).messages.find((message) => message.tool);
    expect(tool?.tool?.status).toBe(approved ? 'completed' : 'failed');
    expect(notifications.at(-1)?.method).not.toBe('bridge/approval.requested');
  });

  it('keeps a conversation usable after its tool output exceeds the context window', async () => {
    const big = (name: string) => `${name}:${'x'.repeat(16 * 1024)}`;
    const { runtime, createChat, send } = await setup({
      files: {
        'ws-one:a.txt': big('a'),
        'ws-one:b.txt': big('b'),
        'ws-one:c.txt': big('c'),
      },
    });
    const threadId = await createChat();
    for (const name of ['a', 'b', 'c']) {
      mockLlama.reply(
        { toolCalls: [{ name: 'read_file', arguments: { path: `${name}.txt`, limit: 16384 } }] },
        { content: `Read ${name}.` },
      );
      await send(threadId, `Read ${name}.txt`);
      await until(() => runtime.threads.get(threadId).status === 'complete', `turn ${name}`);
      expect(runtime.threads.get(threadId).lastError).toBeNull();
    }
    const contextTokens = runtime.models.snapshot().contextTokens ?? 0;
    // Three full reads alone exceed the context; every round still left room to generate.
    expect(3 * Math.ceil((16 * 1024) / mockLlama.charactersPerToken)).toBeGreaterThan(
      contextTokens,
    );
    for (const tokens of mockLlama.promptTokens) {
      expect(tokens + outputReserveTokens(contextTokens)).toBeLessThanOrEqual(contextTokens);
    }
    // Compaction shapes only the model input; stored history keeps every tool result.
    const results = runtime.threads.get(threadId).messages.filter((message) => message.tool);
    expect(results.map((message) => message.content.length > 16 * 1024)).toEqual([
      true,
      true,
      true,
    ]);
    expect(runtime.threads.get(threadId).messages.at(-1)).toMatchObject({ content: 'Read c.' });
  });

  it('switches a chat to a larger model under memory pressure by releasing the resident one first', async () => {
    const small = localModelDefinition(QWEN);
    const large = localModelDefinition('qwen3-4b-q4-k-m');
    const { fake, runtime, server, createChat, send } = await setup({
      downloaded: [small.id, large.id],
      availableBytes: modelMemoryBytes(large) + 16 * 1024 * 1024,
    });
    const first = await createChat(small.id);
    await send(first, 'Hello');
    await until(() => runtime.threads.get(first).status === 'complete', 'the first turn');
    expect(runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId: small.id });

    // With the small model resident, the large one only fits once that memory is credited.
    const memory = fake.native.getMemoryInfo();
    expect(modelMemoryAdmission(large, memory).status).toBe('memory_pressure');
    expect(modelMemoryAdmission(large, memory, runtime.models.resident())).toMatchObject({
      status: 'ready',
      unloadsResident: true,
    });

    const second = await createChat(small.id);
    await server.request('thread/config/set', {
      threadId: second,
      configId: 'model',
      value: large.id,
    });
    // Choosing never loads; the switch happens when the chat sends.
    expect(mockLlama.loads.map((load) => load.modelId)).toEqual([small.id]);
    await send(second, 'Hello again');
    await until(() => runtime.threads.get(second).status === 'complete', 'the switched turn');

    expect(runtime.threads.get(second).lastError).toBeNull();
    expect(mockLlama.loads.map((load) => load.modelId)).toEqual([small.id, large.id]);
    expect([...mockLlama.resident.values()].map((entry) => entry.modelId)).toEqual([large.id]);
    expect(runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId: large.id });
  });
});
