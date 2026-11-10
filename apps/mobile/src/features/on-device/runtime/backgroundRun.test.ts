import { randomUUID } from 'expo-crypto';
import { loadNativeModelContext } from '../models/engine';
import type { NativeLocalRunActivityKind } from '../native/services.types';
import { OnDeviceRuntime } from './runtime';
import { LOCAL_RUN_EXPIRED_MESSAGE } from './runActivity';
import { localAgentStatus } from './status';
import { createFakeOnDeviceNative, FakeLlama, storedLocalThread } from './testing';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));

const modelId = 'qwen3-0.6b-q4-0';

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the controlled lifecycle boundary.');
}

async function harness(kind: NativeLocalRunActivityKind) {
  const llama = new FakeLlama();
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    files: { 'ws-one:a.txt': 'alpha' },
    localRunActivity: kind,
  });
  jest.mocked(loadNativeModelContext).mockImplementation(llama.loader);
  const runtime = new OnDeviceRuntime(fake.native, { emitIntervalMs: 0, threadProgressDelayMs: 0 });
  await runtime.initialize();
  const thread = await runtime.threads.create('ws-one', modelId);
  const residentAtEnd: number[] = [];
  const end = fake.native.endLocalRunActivity;
  jest.spyOn(fake.native, 'endLocalRunActivity').mockImplementation((id, success) => {
    residentAtEnd.push(llama.resident.size);
    end(id, success);
  });
  const controls = () => {
    const run = runtime.loop.snapshot();
    const current = runtime.threads.get(thread.id);
    const status = localAgentStatus({
      run,
      model: runtime.models.snapshot(),
      thread: current,
      modelId,
    });
    return {
      isLoading: run.phase !== 'idle',
      isStopping: run.phase === 'stopping',
      showStopButton: run.threadId === thread.id,
      submitDisabled: runtime.workspaceBusy(),
      status: status.label,
      detail: status.detail,
    };
  };
  const activity = () => [...fake.localRuns.values()].at(-1);
  const backends = () => llama.loads.map((load) => load.backend);
  const answer = () =>
    runtime.threads
      .get(thread.id)
      .messages.filter((message) => message.role === 'assistant')
      .at(-1)?.content;
  const send = (text: string) => runtime.sendMessage(thread.id, text, randomUUID(), jest.fn());
  return {
    llama,
    fake,
    runtime,
    thread,
    controls,
    activity,
    backends,
    answer,
    send,
    residentAtEnd,
  };
}

const settled = {
  isLoading: false,
  isStopping: false,
  showStopButton: false,
  submitDisabled: false,
};

test('a turn keeps generating after the phone locks, finishes on the CPU after iOS refuses the GPU, then releases the model before its activity', async () => {
  const h = await harness('continued');
  h.llama.holdCompletions = true;
  h.llama.reply({ content: 'Finished while locked.' });
  const running = h.send('Explain the workspace');
  await until(() => h.llama.completionPending);
  h.llama.stream('Finished');
  expect(h.controls()).toMatchObject({
    isLoading: true,
    showStopButton: true,
    submitDisabled: true,
    status: 'Generating on this iPhone',
  });

  await h.runtime.background();
  expect(h.runtime.loop.snapshot().phase).toBe('generating');
  expect(h.controls()).toMatchObject({
    isLoading: true,
    isStopping: false,
    showStopButton: true,
    status: 'Generating on this iPhone',
  });
  expect(h.llama.stops).toBe(0);
  expect(h.llama.releases).toBe(0);
  expect(h.activity()?.ended).toBeNull();

  // Metal refuses command buffers from a background app; the in-flight decode fails.
  h.llama.refuseGpu = true;
  h.llama.holdCompletions = false;
  h.llama.finishCompletion();
  const thread = await running;
  expect(thread).toMatchObject({ status: 'complete', lastError: null });
  expect(h.answer()).toBe('Finished while locked.');
  expect(h.llama.decodeFailures).toBe(1);
  expect(h.backends()).toEqual(['gpu', 'cpu']);
  expect(h.controls()).toMatchObject({ ...settled, status: expect.stringContaining('Qwen3') });

  await until(() => h.activity()?.ended !== null);
  expect(h.activity()).toMatchObject({ kind: 'continued', ended: true });
  expect(h.activity()?.subtitles).toContain('Generating on this iPhone');
  expect(h.residentAtEnd).toEqual([0]);
  expect(storedLocalThread(h.fake.documents, h.thread.id)?.status).toBe('complete');

  // Returning warms the model again on the GPU without replaying the turn.
  h.llama.refuseGpu = false;
  await h.runtime.foreground();
  expect(h.backends()).toEqual(['gpu', 'cpu', 'gpu']);
  expect(h.llama.executions).toHaveLength(2);
  await h.runtime.dispose();
});

test.each(['continued', 'background'] as const)(
  'when iOS ends %s time the turn stops with an explanation, unloads, and can be retried',
  async (kind) => {
    const h = await harness(kind);
    h.llama.holdCompletions = true;
    h.llama.reply({ content: 'Never finished.' });
    const running = h.send('Keep working');
    await until(() => h.llama.completionPending);
    await h.runtime.background();
    expect(h.controls()).toMatchObject({ isLoading: true, isStopping: false });

    h.fake.expireLocalRun();
    expect(h.controls()).toMatchObject({ isLoading: true, isStopping: true, showStopButton: true });
    const thread = await running;
    expect(thread).toMatchObject({ status: 'interrupted', lastError: LOCAL_RUN_EXPIRED_MESSAGE });
    await until(() => h.activity()?.ended !== null);
    expect(h.activity()?.ended).toBe(false);
    expect(h.residentAtEnd).toEqual([0]);
    expect(h.llama.stops).toBeGreaterThan(0);
    expect(h.controls()).toEqual({
      ...settled,
      status: 'Stopped · completed edits are preserved',
      detail: LOCAL_RUN_EXPIRED_MESSAGE,
    });
    expect(storedLocalThread(h.fake.documents, h.thread.id)).toMatchObject({
      status: 'interrupted',
      lastError: LOCAL_RUN_EXPIRED_MESSAGE,
    });

    h.llama.holdCompletions = false;
    h.llama.reply({ content: 'Finished on retry.' });
    await h.runtime.foreground();
    await expect(h.runtime.retryTurn(h.thread.id)).resolves.toMatchObject({
      status: 'complete',
    });
    expect(h.answer()).toBe('Finished on retry.');
    expect(h.activity()?.ended).toBe(true);
    await h.runtime.dispose();
  },
);

test('returning mid-turn moves generation back to the GPU and keeps the model after it settles', async () => {
  const h = await harness('continued');
  h.llama.holdCompletions = true;
  h.llama.reply(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    { content: 'The file says alpha.' },
  );
  const running = h.send('Read a.txt');
  await until(() => h.llama.completionPending);
  await h.runtime.background();
  h.llama.refuseGpu = true;
  h.llama.finishCompletion();
  await until(() => h.llama.completionPending && h.backends().length === 2);
  expect(h.backends()).toEqual(['gpu', 'cpu']);

  h.llama.refuseGpu = false;
  h.llama.holdCompletions = false;
  await h.runtime.foreground();
  expect(h.runtime.loop.snapshot().phase).toBe('generating');
  h.llama.finishCompletion();
  await expect(running).resolves.toMatchObject({ status: 'complete' });
  expect(h.answer()).toBe('The file says alpha.');
  expect(h.backends()).toEqual(['gpu', 'cpu', 'gpu']);
  expect(h.llama.resident.size).toBe(1);
  expect(h.runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId });
  expect(h.activity()).toMatchObject({ ended: true });
  expect(h.activity()?.subtitles).toContain('Running read_file');
  expect(h.residentAtEnd).toEqual([1]);
  expect(h.controls()).toMatchObject(settled);
  await h.runtime.dispose();
});

test('a turn waiting for approval stays pending in the background and continues after the answer', async () => {
  const h = await harness('continued');
  h.llama.reply({ toolCalls: [{ name: 'git_push', arguments: {} }] }, { content: 'Not pushed.' });
  const running = h.send('Push my work');
  await until(() => h.runtime.loop.snapshot().phase === 'approval');
  await h.runtime.background();
  expect(h.runtime.loop.snapshot().phase).toBe('approval');
  expect(h.activity()?.subtitles.at(-1)).toBe('Waiting for your approval');
  expect(h.controls()).toMatchObject({ isLoading: true, showStopButton: true });

  await h.runtime.foreground();
  h.runtime.loop.resolveApproval(h.runtime.loop.snapshot().approval!.callId, false);
  await expect(running).resolves.toMatchObject({ status: 'complete' });
  expect(h.fake.calls).not.toContain('pushWorkspaceGit:["ws-one",null]');
  expect(h.answer()).toBe('Not pushed.');
  expect(h.activity()?.ended).toBe(true);
  expect(h.controls()).toMatchObject(settled);
  await h.runtime.dispose();
});

test('a memory warning still stops a background turn and returns its time', async () => {
  const h = await harness('continued');
  h.llama.holdCompletions = true;
  const running = h.send('Keep working');
  await until(() => h.llama.completionPending);
  await h.runtime.background();
  await h.runtime.relieveMemory();
  await expect(running).resolves.toMatchObject({
    status: 'interrupted',
    lastError: 'Stopped. Completed edits are preserved.',
  });
  await until(() => h.activity()?.ended !== null);
  expect(h.activity()?.ended).toBe(false);
  expect(h.llama.resident.size).toBe(0);
  expect(h.controls()).toMatchObject(settled);
  await h.runtime.dispose();
});

test('without background time, leaving the app stops the turn and holds nothing', async () => {
  const h = await harness('none');
  h.llama.holdCompletions = true;
  const running = h.send('Keep working');
  await until(() => h.llama.completionPending);
  await h.runtime.background();
  await expect(running).resolves.toMatchObject({
    status: 'interrupted',
    lastError: 'Stopped. Completed edits are preserved.',
  });
  expect(h.fake.calls).toContain('beginLocalRunActivity:["none"]');
  expect(h.fake.calls.some((call) => call.startsWith('endLocalRunActivity'))).toBe(false);
  expect(h.llama.resident.size).toBe(0);
  expect(h.controls()).toMatchObject(settled);
  await h.runtime.dispose();
});

test('an activity granted to a turn that is not admitted is returned at once', async () => {
  const h = await harness('continued');
  const operation = h.runtime.workspaceTask('Pushing', () => new Promise<void>(() => undefined));
  void operation;
  await expect(h.send('Hello')).rejects.toThrow('settle');
  expect(h.activity()).toMatchObject({ ended: false });
  expect(h.llama.loads).toHaveLength(0);
});

test('a turn refused at admission after the phone locked still unloads the model before returning its time', async () => {
  const h = await harness('continued');
  h.llama.holdLoads = true;
  const loading = h.runtime.selectModel(modelId, h.thread.id);
  await until(() => h.llama.loadPending);
  const sending = h.send('Hello');
  await until(() => h.activity() !== undefined);
  let finishPush = (): void => undefined;
  const push = h.runtime.workspaceTask(
    'Pushing',
    () =>
      new Promise<void>((resolve) => {
        finishPush = resolve;
      }),
  );
  await h.runtime.background();
  h.llama.holdLoads = false;
  h.llama.finishLoad();
  await loading;
  await expect(sending).rejects.toThrow(/^Wait for/);
  expect(h.llama.executions).toHaveLength(0);
  // Backgrounding waits for the push; the activity keeps the app running until the model unloads.
  expect(h.activity()?.ended).toBeNull();
  finishPush();
  await push;
  await until(() => h.activity()?.ended !== null);
  expect(h.activity()?.ended).toBe(false);
  expect(h.residentAtEnd).toEqual([0]);
  expect(h.llama.resident.size).toBe(0);
  expect(h.controls()).toMatchObject(settled);
  await h.runtime.foreground();
  expect(h.llama.resident.size).toBe(1);
  await h.runtime.dispose();
});
