import { randomUUID } from 'expo-crypto';
import { fetch as fetchPage } from 'expo/fetch';
import type { LocalModelMessage } from '../models/engine';
import { loadNativeModelContext } from '../models/engine';
import { LocalModelSession } from '../models/session';
import { LocalAgentLoop, type LocalRunSnapshot } from './agentLoop';
import { childEntries, CHILD_ROUNDS } from './delegation';
import { LOCAL_TOOL_DEFINITIONS, localToolApproval, localToolExecutor } from './localTools';
import { LocalThreadRepository } from './threads';
import {
  createFakeOnDeviceNative,
  FakeLlama,
  storedLocalThread,
  type ScriptedReply,
} from './testing';
import { localChatProjection } from './chatProjection';
import { localAgentStatus } from './status';
import type { LocalThread } from './types';
import { OnDeviceRuntime } from './runtime';
import { createRuntimeAgentPort } from '../transport/runtimePort';
import { LocalEventProjector } from '../transport/events';
import { localThreadSnapshot } from '../transport/wire';
import { localModelDefinition } from '../models/catalog';
import { LocalWorkspaceGuidance } from './workspaceGuidance';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the controlled lifecycle boundary.');
}

const tool = (name: string, args: Record<string, unknown> = {}): ScriptedReply => ({
  toolCalls: [{ name, arguments: args }],
});
const tasks = (prompts = ['child A', 'child B'], agent = 'explore'): ScriptedReply =>
  tool('task', { tasks: prompts.map((prompt) => ({ agent, prompt })) });
const user = (messages: LocalModelMessage[]): string =>
  messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
const results = (messages: LocalModelMessage[]): LocalModelMessage[] =>
  messages.filter((message) => message.role === 'tool');

async function harness(script: (messages: LocalModelMessage[]) => ScriptedReply, guidance = false) {
  const llama = new FakeLlama();
  const modelId = 'qwen3-0.6b-q4-0';
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    files: {
      'ws-one:a.txt': 'alpha',
      'ws-one:b.txt': 'beta',
      ...(guidance ? { 'ws-one:AGENTS.md': 'Keep scoped workspace evidence in every task.' } : {}),
    },
  });
  let generating = 0;
  let highWater = 0;
  const prompts: LocalModelMessage[][] = [];
  const session = new LocalModelSession(
    fake.native,
    async (...args) => {
      const context = await llama.loader(...args);
      const completion = context.completion;
      context.completion = async (params, callback) => {
        generating += 1;
        highWater = Math.max(highWater, generating);
        const messages = JSON.parse(params.prompt!) as LocalModelMessage[];
        prompts.push(messages);
        llama.reply(script(messages));
        try {
          return await completion(params, callback);
        } finally {
          generating -= 1;
        }
      };
      return context;
    },
    jest.fn(),
  );
  const threads = new LocalThreadRepository(fake.native, jest.fn(), 0);
  await threads.initialize();
  const thread = await threads.create('ws-one', modelId);
  const events: LocalRunSnapshot[] = [];
  const loop = new LocalAgentLoop(
    threads,
    session,
    LOCAL_TOOL_DEFINITIONS,
    localToolExecutor(
      fake.native,
      () => ({ name: 'Test', email: 'test@example.com' }),
      async () => null,
      () => undefined,
    ),
    (event) => events.push(event),
    localToolApproval,
    undefined,
    guidance ? new LocalWorkspaceGuidance(fake.native) : undefined,
  );
  const current = () => threads.get(thread.id);
  const start = () => loop.send(thread.id, 'parent private request', randomUUID());
  const state = () =>
    localAgentStatus({
      run: loop.snapshot(),
      model: session.snapshot(),
      thread: current(),
      modelId,
    });
  return {
    ...fake,
    llama,
    session,
    threads,
    thread,
    events,
    loop,
    current,
    start,
    state,
    prompts,
    highWater: () => highWater,
    close: async () => {
      await threads.flush();
      await session.dispose();
    },
  };
}

test('parent and fresh child generations all receive selected workspace instructions', async () => {
  const h = await harness(
    (messages) =>
      user(messages) === 'parent private request'
        ? results(messages).length
          ? { content: 'Parent verified child evidence.' }
          : tasks()
        : { content: 'Scoped child evidence.' },
    true,
  );
  await h.start();
  expect(childEntries(h.current())).toHaveLength(2);
  expect(h.prompts).toHaveLength(4);
  expect(
    h.prompts.every((messages) =>
      messages[0]?.content.includes('Keep scoped workspace evidence in every task.'),
    ),
  ).toBe(true);
  await h.close();
});

test('parallel delegation admits two fresh children, overlaps real executor reads and serializes native inference', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length ? { content: 'Parent verified child evidence.' } : tasks();
    }
    const path = user(messages) === 'child A' ? 'a.txt' : 'b.txt';
    return results(messages).length
      ? { content: `Read ${path}: verified.` }
      : tool('read_file', { path });
  });
  const release = deferred<void>();
  const projectionContext = () => ({
    workspaces: [{ id: 'ws-one', name: 'Demo', isRepository: true }],
    models: [localModelDefinition(h.thread.modelId)],
  });
  const projector = new LocalEventProjector(projectionContext);
  projector.prime([h.current()]);
  const read = h.native.readWorkspaceFile;
  let readers = 0;
  const nativeRead = jest
    .spyOn(h.native, 'readWorkspaceFile')
    .mockImplementation(async (...args) => {
      readers += 1;
      await release.promise;
      return read(...args);
    });
  let settled = false;
  const running = h.start().then((thread) => {
    settled = true;
    return thread;
  });
  await until(() => readers === 2);
  expect(childEntries(h.current()).map((child) => child.status)).toEqual(['running', 'running']);
  expect(h.current().status).toBe('running');
  expect(h.loop.snapshot().phase).not.toBe('idle');
  expect(h.state().kind).toBe('busy');
  expect(settled).toBe(false);
  expect(h.llama.loads).toHaveLength(1);
  expect(h.llama.ownershipHighWater).toBe(1);
  expect(h.highWater()).toBe(1);
  const activities = localChatProjection(h.current(), 'Demo').messages.filter(
    (message) => message.role === 'activity',
  );
  expect(activities).toHaveLength(2);
  expect(activities.every((message) => message.pending)).toBe(true);
  const notifications = projector.diff([h.current()]);
  expect(
    notifications.filter((notification) =>
      JSON.stringify(notification).includes('"activityType":"dappercode.subagent"'),
    ),
  ).toHaveLength(2);
  expect(
    localThreadSnapshot(h.current(), projectionContext()).acpSnapshot?.tools.filter(
      (entry) => entry.subagent,
    ),
  ).toHaveLength(2);
  const durable = storedLocalThread(h.documents, h.thread.id)!;
  expect(
    childEntries(durable).every((child) =>
      child.messages.some(
        (message) => message.tool?.status === 'pending' || message.tool?.status === 'running',
      ),
    ),
  ).toBe(true);
  release.resolve();
  const complete = await running;
  expect(complete.status).toBe('complete');
  expect(h.loop.snapshot().phase).toBe('idle');
  expect(h.state().kind).toBe('ready');
  expect(childEntries(complete).every((child) => child.status === 'complete')).toBe(true);
  expect(nativeRead.mock.calls.map(([workspace]) => workspace)).toEqual(['ws-one', 'ws-one']);
  for (const prompt of h.prompts.filter((messages) => user(messages).startsWith('child'))) {
    expect(prompt.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(prompt)).not.toContain('parent private request');
  }
  expect(h.llama.predictBudgets.slice(1, -1).every((budget) => budget <= 512)).toBe(true);
  expect(h.current().messages.find((message) => message.tool?.name === 'task')?.content).toContain(
    'child_id',
  );
  const settledEvents = projector.diff([h.current()]);
  expect(
    settledEvents.filter((notification) =>
      JSON.stringify(notification).includes('"agentStatus":"completed"'),
    ),
  ).toHaveLength(2);
  await h.close();
});

test('parallel root read fan-out waits for every independent tool before the next model round', async () => {
  const h = await harness((messages) =>
    results(messages).length
      ? { content: 'Both read.' }
      : {
          toolCalls: ['a.txt', 'b.txt'].map((path) => ({ name: 'read_file', arguments: { path } })),
        },
  );
  const gates = [deferred<void>(), deferred<void>()];
  const read = h.native.readWorkspaceFile;
  let readers = 0;
  jest.spyOn(h.native, 'readWorkspaceFile').mockImplementation(async (...args) => {
    const gate = gates[readers++]!;
    await gate.promise;
    return read(...args);
  });
  const pending = h.start();
  await until(() => readers === 2);
  gates[0]!.resolve();
  await until(() => h.current().messages.some((message) => message.tool?.status === 'completed'));
  expect(h.prompts).toHaveLength(1);
  expect(h.current().status).toBe('running');
  gates[1]!.resolve();
  await pending;
  expect(h.prompts).toHaveLength(2);
  await h.close();
});

test.each(['generate', 'tool', 'approval'] as const)(
  'cancellation during child %s drains all children and settles Stop/composer state',
  async (boundary) => {
    const h = await harness((messages) => {
      if (user(messages) === 'parent private request') {
        return tasks(['child A', 'child B'], 'general');
      }
      return boundary === 'approval' ? tool('git_push') : tool('read_file', { path: 'a.txt' });
    });
    const release = deferred<void>();
    let readers = 0;
    const read = h.native.readWorkspaceFile;
    jest.spyOn(h.native, 'readWorkspaceFile').mockImplementation(async (...args) => {
      readers += 1;
      await release.promise;
      return read(...args);
    });
    const push = jest.spyOn(h.native, 'pushWorkspaceGit');
    const pending = h.start();
    if (boundary === 'generate') {
      // Let the parent finish; hold the first child and keep its sibling queued.
      h.llama.holdCompletions = true;
      await until(() => h.llama.completionPending);
      h.llama.finishCompletion();
      await until(() => h.llama.executions.length === 2 && h.llama.completionPending);
    } else if (boundary === 'tool') {
      await until(() => readers === 2);
    } else {
      await until(() => h.loop.snapshot().phase === 'approval');
    }
    const approvalId = h.loop.snapshot().approval?.callId;
    let stopped = false;
    const stopping = h.loop.stop().then(() => {
      stopped = true;
    });
    if (boundary === 'tool') {
      expect(h.loop.snapshot().phase).toBe('stopping');
      expect(h.state().label).toContain('waiting');
      expect(stopped).toBe(false);
      release.resolve();
    }
    await stopping;
    await pending;
    expect(h.current().status).toBe('interrupted');
    expect(h.loop.snapshot()).toMatchObject({ phase: 'idle', approval: null });
    expect(h.state()).toMatchObject({ kind: 'attention', blocking: false });
    expect(h.state().label).toContain('Stopped');
    expect(localChatProjection(h.current(), 'Demo')).toMatchObject({
      status: 'idle',
      activeTurnId: null,
    });
    expect(childEntries(h.current()).every((child) => child.status === 'interrupted')).toBe(true);
    expect(push).not.toHaveBeenCalled();
    if (approvalId) {
      expect(() => h.loop.resolveApproval(approvalId, true)).toThrow('no longer pending');
    }
    const count = h.llama.executions.length;
    h.llama.finishCompletion();
    expect(h.llama.executions).toHaveLength(count);
    await h.close();
  },
);

test('read-only children and recursive task calls are blocked by runtime even when emitted by the model', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length ? { content: 'Failures acknowledged.' } : tasks();
    }
    if (!results(messages).length) {
      return tool('write_file', { path: 'unrequested.txt', content: 'bad' });
    }
    if (results(messages).length === 1) {
      return tasks(['nested']);
    }
    return { content: 'Could not mutate or delegate.' };
  });
  const write = jest.spyOn(h.native, 'writeWorkspaceFile');
  await h.start();
  expect(write).not.toHaveBeenCalled();
  for (const child of childEntries(h.current())) {
    expect(child.messages.filter((message) => message.tool?.status === 'failed')).toHaveLength(2);
    expect(JSON.stringify(child.messages)).toContain('read-only or requested recursive');
  }
  expect(childEntries(h.current())).toHaveLength(2);
  await h.close();
});

test('general children do not inherit sibling version observations and cannot edit without their own read', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length
        ? { content: 'Done.' }
        : tasks(['child A', 'child B'], 'general');
    }
    if (results(messages).length) {
      return { content: 'Checked.' };
    }
    return user(messages) === 'child A'
      ? tool('read_file', { path: 'a.txt' })
      : tool('edit_file', { path: 'a.txt', old_text: 'alpha', new_text: 'beta' });
  });
  const readDone = deferred<void>();
  const read = h.native.readWorkspaceFile;
  jest.spyOn(h.native, 'readWorkspaceFile').mockImplementation(async (...args) => {
    const result = await read(...args);
    readDone.resolve();
    return { ...result, revision: 'a'.repeat(64) };
  });
  const edit = jest.spyOn(h.native, 'editWorkspaceFile');
  await h.start();
  await readDone.promise;
  expect(edit).not.toHaveBeenCalled();
  expect(JSON.stringify(childEntries(h.current())[1]!.messages)).toContain('revision');
  await h.close();
});

test('child failure is surfaced to parent, while a healthy sibling and resident model survive', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length ? { content: 'One child failed.' } : tasks();
    }
    return user(messages) === 'child A'
      ? { fail: 'Injected native failure' }
      : { content: 'B succeeded' };
  });
  await h.start();
  expect(childEntries(h.current()).map((child) => child.status)).toEqual(['failed', 'complete']);
  expect(h.current().messages.find((message) => message.tool?.name === 'task')?.content).toContain(
    'Injected native failure',
  );
  expect(h.session.snapshot().phase).toBe('ready');
  expect(h.loop.snapshot().phase).toBe('idle');
  await h.close();
});

test('child step, fanout, admission and nesting limits return explicit failures without runaway work', async () => {
  let batch = 0;
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      batch += 1;
      if (batch === 1) {
        return tasks(['1', '2', '3', '4']);
      }
      if (batch <= 4) {
        return tasks([
          `child A ${String(batch)}`,
          `child B ${String(batch)}`,
          `child C ${String(batch)}`,
        ]);
      }
      return { content: 'Bound reached.' };
    }
    return tool('read_file', { path: results(messages).length % 2 ? 'a.txt' : 'b.txt' });
  });
  await h.start();
  expect(childEntries(h.current())).toHaveLength(6);
  expect(childEntries(h.current()).every((child) => child.status === 'interrupted')).toBe(true);
  expect(
    childEntries(h.current()).every(
      (child) => child.messages.filter((message) => message.tool).length <= CHILD_ROUNDS,
    ),
  ).toBe(true);
  const taskMessages = h.current().messages.filter((message) => message.tool?.name === 'task');
  expect(taskMessages[0]!.content).toContain('1-3');
  expect(taskMessages.at(-1)!.content).toContain('6 child admissions');
  await h.close();
});

test('restart recovery persists nested history, interrupts active children, resumes by scoped ID and never replays completed tools', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length ? { content: 'Done.' } : tasks(['child A']);
    }
    return results(messages).length
      ? { content: 'Verified alpha.' }
      : tool('read_file', { path: 'a.txt' });
  });
  await h.start();
  await h.threads.flush();
  const child = childEntries(h.current())[0]!;
  const completedMessages = structuredClone(child.messages);
  // Persist the exact crash boundary: a new nested intent exists, but its result does not.
  h.threads.change(h.thread.id, (thread): LocalThread => ({
    ...thread,
    status: 'running',
    activeTurnId: 'crash',
    messages: thread.messages.map((message) =>
      !message.children
        ? message
        : {
            ...message,
            children: message.children.map((entry) => ({
              ...entry,
              status: 'running',
              messages: [
                ...entry.messages,
                {
                  id: 'crash-intent',
                  role: 'assistant',
                  content: '',
                  createdAt: entry.updatedAt,
                  toolCalls: [
                    {
                      id: 'unadmitted-write',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{}' },
                    },
                  ],
                },
              ],
            })),
          },
    ),
  }));
  await h.threads.save(h.thread.id);
  await h.threads.flush();
  const restored = new LocalThreadRepository(h.native, jest.fn(), 0);
  await restored.initialize();
  expect(restored.get(h.thread.id).status).toBe('interrupted');
  const recoveredChild = childEntries(restored.get(h.thread.id))[0]!;
  expect(recoveredChild).toMatchObject({ id: child.id, status: 'interrupted' });
  expect(recoveredChild.messages.slice(0, completedMessages.length)).toEqual(completedMessages);
  expect(recoveredChild.messages.at(-1)?.tool).toMatchObject({
    callId: 'unadmitted-write',
    status: 'interrupted',
  });
  const reads = h.calls.filter((call) => call.startsWith('readWorkspaceFile')).length;
  const resumed = new LocalAgentLoop(
    restored,
    h.session,
    LOCAL_TOOL_DEFINITIONS,
    localToolExecutor(
      h.native,
      () => null,
      async () => null,
      () => undefined,
    ),
    jest.fn(),
    localToolApproval,
  );
  // A continuation is a new prompt, not replay of the old child turn.
  const nativeCompletion = h.llama.reply.bind(h.llama);
  nativeCompletion(
    tool('task', {
      tasks: [{ agent: 'explore', child_id: child.id, prompt: 'Summarize prior evidence only' }],
    }),
    { content: 'Already read alpha.' },
    { content: 'Parent continued safely.' },
  );
  await resumed.retry(h.thread.id);
  expect(h.calls.filter((call) => call.startsWith('readWorkspaceFile'))).toHaveLength(reads);
  expect(childEntries(restored.get(h.thread.id))).toHaveLength(1);
  expect(childEntries(restored.get(h.thread.id))[0]!.status).toBe('complete');
  await restored.flush();
  await restored.remove(h.thread.id);
  const reloaded = new LocalThreadRepository(h.native, jest.fn());
  await reloaded.initialize();
  expect(reloaded.find(h.thread.id)).toBeNull();
  await h.session.dispose();
});

test('foreign workspace and conversation child IDs cannot be resumed or exposed', async () => {
  let foreignId = '';
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length ? { content: 'Done.' } : tasks(['child A']);
    }
    if (user(messages) === 'foreign') {
      return results(messages).length
        ? { content: 'Denied.' }
        : tool('task', {
            tasks: [{ agent: 'explore', child_id: foreignId, prompt: 'Read secrets' }],
          });
    }
    return { content: 'Private child evidence.' };
  });
  await h.start();
  foreignId = childEntries(h.current())[0]!.id;
  for (const workspace of ['ws-one', 'foreign-workspace']) {
    const other = await h.threads.create(workspace, h.thread.modelId);
    await h.loop.send(other.id, 'foreign', randomUUID());
    expect(childEntries(h.threads.get(other.id))).toHaveLength(0);
    expect(JSON.stringify(h.threads.get(other.id).messages)).toContain(
      'unavailable in this conversation',
    );
    expect(JSON.stringify(h.threads.get(other.id).messages)).not.toContain(
      'Private child evidence',
    );
  }
  await h.close();
});

test('parallel pending approvals remain individually gated and global policy changes release each exactly once', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length
        ? { content: 'Done.' }
        : tasks(['child A', 'child B'], 'general');
    }
    return results(messages).length ? { content: 'Push handled.' } : tool('git_push');
  });
  const push = jest.spyOn(h.native, 'pushWorkspaceGit');
  const pending = h.start();
  await until(
    () =>
      childEntries(h.current()).every((child) =>
        child.messages.some((message) => message.tool?.name === 'git_push'),
      ) && childEntries(h.current()).length === 2,
  );
  expect(push).not.toHaveBeenCalled();
  const first = h.loop.snapshot().approval!;
  expect(first.threadId).toBe(h.thread.id);
  h.loop.resolveApproval(first.callId, false);
  await until(() => h.loop.snapshot().approval?.callId !== first.callId);
  expect(push).not.toHaveBeenCalled();
  expect(h.loop.snapshot().phase).toBe('approval');
  h.loop.setApprovalPolicy('never');
  await pending;
  expect(push).toHaveBeenCalledTimes(1);
  expect(
    childEntries(h.current())
      .flatMap((child) => child.messages)
      .some((message) => message.content.includes('user declined')),
  ).toBe(true);
  await h.close();
});

test('parallel general edits keep separate observed revisions and surface native CAS conflicts', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return results(messages).length
        ? { content: 'Conflicts reviewed.' }
        : tasks(['child A', 'child B'], 'general');
    }
    if (!results(messages).length) {
      return tool('read_file', { path: 'a.txt' });
    }
    if (results(messages).length === 1) {
      return tool('edit_file', { path: 'a.txt', old_text: 'alpha', new_text: user(messages) });
    }
    return { content: 'Edit checked.' };
  });
  const gate = deferred<void>();
  let readers = 0;
  const read = h.native.readWorkspaceFile;
  jest.spyOn(h.native, 'readWorkspaceFile').mockImplementation(async (...args) => {
    readers += 1;
    await gate.promise;
    return { ...(await read(...args)), revision: 'a'.repeat(64) };
  });
  let revision = 'a'.repeat(64);
  const edit = jest
    .spyOn(h.native, 'editWorkspaceFile')
    .mockImplementation(async (_workspace, _path, _old, _next, expected) => {
      if (expected !== revision) {
        throw new Error('FILE_REVISION_CONFLICT');
      }
      revision = 'b'.repeat(64);
      return revision;
    });
  const pending = h.start();
  await until(() => readers === 2);
  gate.resolve();
  await pending;
  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.calls.map((call) => call[4])).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
  expect(JSON.stringify(childEntries(h.current()))).toContain('FILE_REVISION_CONFLICT');
  await h.close();
});

test('Stop drains an admitted child mutation but cancels its queued sibling without side effects', async () => {
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return tasks(['child A', 'child B'], 'general');
    }
    return tool('write_file', {
      path: user(messages) === 'child A' ? 'first.txt' : 'second.txt',
      content: 'explicit delegated edit',
    });
  });
  const finish = deferred<string>();
  const write = jest.spyOn(h.native, 'writeWorkspaceFile').mockImplementation(() => finish.promise);
  const pending = h.start();
  await until(
    () =>
      childEntries(h.current()).every((child) =>
        child.messages.some((message) => message.tool?.name === 'write_file'),
      ) && childEntries(h.current()).length === 2,
  );
  expect(write).toHaveBeenCalledTimes(1);
  const stopping = h.loop.stop();
  expect(h.loop.snapshot().phase).toBe('stopping');
  finish.resolve('a'.repeat(64));
  await stopping;
  await pending;
  expect(write).toHaveBeenCalledTimes(1);
  expect(childEntries(h.current()).map((child) => child.status)).toEqual([
    'interrupted',
    'interrupted',
  ]);
  const tools = childEntries(h.current())
    .flatMap((child) => child.messages)
    .filter((message) => message.tool);
  expect(tools.map((message) => message.tool?.status)).toEqual(['completed', 'interrupted']);
  expect(h.loop.snapshot().phase).toBe('idle');
  await h.close();
});

test('Stop aborts two independent child web requests through the real web executor', async () => {
  const signals: AbortSignal[] = [];
  jest.mocked(fetchPage).mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('The request is missing its cancellation signal.'));
          return;
        }
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('Request aborted')), {
          once: true,
        });
      }),
  );
  const h = await harness((messages) => {
    if (user(messages) === 'parent private request') {
      return tasks();
    }
    return tool('web_fetch', { url: 'https://example.com/public-docs' });
  });
  h.loop.setApprovalPolicy('never');
  const pending = h.start();
  await until(() => signals.length === 2);
  expect(new Set(signals).size).toBe(2);
  expect(h.current().status).toBe('running');
  await h.loop.stop();
  await pending;
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(childEntries(h.current()).map((child) => child.status)).toEqual([
    'interrupted',
    'interrupted',
  ]);
  expect(h.loop.snapshot().phase).toBe('idle');
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await h.close();
});

test('invalid child IDs and cross-workspace arguments reject the whole batch before admission', async () => {
  const h = await harness((messages) => {
    const turn = messages.slice(messages.map((message) => message.role).lastIndexOf('user'));
    if (results(turn).length) {
      return { content: 'Rejected safely.' };
    }
    if (user(messages).includes('workspace attempt')) {
      return tool('task', {
        tasks: [{ agent: 'explore', prompt: 'Foreign task', workspaceId: 'foreign-workspace' }],
      });
    }
    return tool('task', {
      tasks: [
        { agent: 'explore', prompt: 'Valid new task' },
        {
          agent: 'explore',
          prompt: 'Foreign task',
          child_id: '00000000-0000-4000-8000-999999999999',
        },
      ],
    });
  });
  await h.start();
  await h.loop.send(h.thread.id, 'foreign workspace attempt', randomUUID());
  expect(childEntries(h.current())).toHaveLength(0);
  expect(
    h
      .current()
      .messages.filter((message) => message.tool)
      .every((message) => message.tool?.status === 'failed'),
  ).toBe(true);
  expect(h.llama.executions).toHaveLength(4);
  expect(h.calls.filter((call) => call.startsWith('readWorkspaceFile'))).toHaveLength(0);
  await h.close();
});

test('read_child retrieves paged saved evidence but rejects stale IDs after workspace changes', async () => {
  let childId = '';
  const answer = 'evidence '.repeat(400);
  const h = await harness((messages) => {
    const request = user(messages);
    if (request === 'parent private request') {
      return results(messages).length ? { content: 'Done.' } : tasks(['child A']);
    }
    if (request.includes('retrieve')) {
      return results(messages.slice(messages.map((message) => message.role).lastIndexOf('user')))
        .length
        ? { content: 'Evidence reviewed.' }
        : tool('read_child', { child_id: childId, offset: 0, limit: 8192 });
    }
    return { content: answer };
  });
  await h.start();
  childId = childEntries(h.current())[0]!.id;
  const taskResult = h.current().messages.find((message) => message.tool?.name === 'task')!.content;
  expect(taskResult).toContain('"truncated":true');
  await h.loop.send(h.thread.id, 'retrieve saved evidence', randomUUID());
  const evidence = h.current().messages.find((message) => message.tool?.name === 'read_child')!;
  expect(evidence.content).toContain(answer);
  h.threads.change(h.thread.id, (thread) => ({ ...thread, workspaceId: 'other-workspace' }));
  await h.loop.send(h.thread.id, 'retrieve forbidden evidence', randomUUID());
  const latest = h
    .current()
    .messages.filter((message) => message.tool?.name === 'read_child')
    .at(-1)!;
  expect(latest.tool?.status).toBe('failed');
  expect(latest.content).toContain('unavailable');
  expect(latest.content).not.toContain(answer);
  await h.close();
});

test('background lifecycle drains two child tools before unload and releases Stop/composer controls', async () => {
  const llama = new FakeLlama();
  const modelId = 'qwen3-0.6b-q4-0';
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    files: { 'ws-one:a.txt': 'alpha' },
  });
  jest.mocked(loadNativeModelContext).mockImplementation(llama.loader);
  const runtime = new OnDeviceRuntime(fake.native, { emitIntervalMs: 0, threadProgressDelayMs: 0 });
  await runtime.initialize();
  const port = createRuntimeAgentPort(runtime);
  const thread = await port.createThread('ws-one', modelId);
  llama.reply(tasks(), tool('read_file', { path: 'a.txt' }), tool('read_file', { path: 'a.txt' }));
  const release = deferred<void>();
  const read = fake.native.readWorkspaceFile;
  let readers = 0;
  jest.spyOn(fake.native, 'readWorkspaceFile').mockImplementation(async (...args) => {
    if (args[1] === 'a.txt') {
      readers += 1;
      await release.promise;
    }
    return read(...args);
  });
  const pending = port.send(thread.id, 'Delegate reads', randomUUID(), jest.fn());
  await until(() => readers === 2);
  const controls = () => ({
    isLoading: port.run().phase !== 'idle',
    showStopButton: port.run().threadId === thread.id,
    submitDisabled: runtime.workspaceBusy(),
    isStopping: port.run().phase === 'stopping',
  });
  expect(controls()).toEqual({
    isLoading: true,
    showStopButton: true,
    submitDisabled: true,
    isStopping: false,
  });
  const background = runtime.background();
  expect(controls()).toEqual({
    isLoading: true,
    showStopButton: true,
    submitDisabled: true,
    isStopping: true,
  });
  expect(llama.releases).toBe(0);
  release.resolve();
  await background;
  await pending;
  expect(controls()).toEqual({
    isLoading: false,
    showStopButton: false,
    submitDisabled: false,
    isStopping: false,
  });
  expect(port.thread(thread.id)).toMatchObject({ status: 'interrupted', activeTurnId: null });
  expect(
    childEntries(port.thread(thread.id)!).every((child) => child.status === 'interrupted'),
  ).toBe(true);
  expect(llama.releases).toBe(1);
  expect(llama.resident.size).toBe(0);
  expect(storedLocalThread(fake.documents, thread.id)?.status).toBe('interrupted');
  await runtime.dispose();
});
