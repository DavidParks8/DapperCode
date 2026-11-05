import { EventType } from '@ag-ui/core';
import { TOOL_META_EVENT_NAME } from '@bridge/toolMeta';

import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import { toPendingApproval } from '../../chat/helpers/status';
import { mapChat, toRawThread } from '@bridge/mapping/chatMapping';
import { OnDeviceNativeError } from '../native/services.errors';
import { OnDeviceOfflineError } from '../runtime/network';
import type { LocalNotification } from './events';
import { RUN_ACTIVITY_EVENT_NAME, type RunActivity } from '@bridge/runActivity';
import { TURN_RETRY_METHOD } from '../../chat/turn/turnRetry';
import {
  LocalBridgeServer,
  LocalRpcError,
  LOCAL_IMPLEMENTED_METHODS,
  LOCAL_TURN_RETRY_METHOD,
} from './server';
import { localModelDisplayName } from '../models/catalog';
import { FakeAgentPort } from './testing';
import {
  describeLocalTool,
  LOCAL_AGENT_ID,
  LOCAL_UNAVAILABLE_WORKSPACE,
  LOCAL_WORKSPACE_ROOT,
  localWorkspacePaths,
} from './wire';

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

function setup() {
  const port = new FakeAgentPort();
  const server = new LocalBridgeServer(port);
  const notifications: LocalNotification[] = [];
  server.onNotification((notification) => notifications.push(notification));
  server.start();
  const events = () =>
    notifications
      .map((notification) => parseAgUiEventNotification(notification))
      .filter((envelope) => envelope !== null)
      .map((envelope) => envelope.event);
  return { port, server, notifications, events };
}

/** Lets an RPC handler reach the port (handlers await before calling it). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function rpcError(promise: Promise<unknown>): Promise<LocalRpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LocalRpcError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the request to fail');
}

async function createChat(server: LocalBridgeServer, submissionId = 'create-1') {
  const response = (await server.request('bridge/thread/create', {
    submissionId,
    threadStart: { cwd: DEMO, model: 'qwen3-1.7b-q4-k-m' },
  })) as { thread: { id: string } };
  return response.thread.id;
}

describe('LocalBridgeServer', () => {
  it.each(['untrusted', 'on-request', 'on-failure', 'never'])(
    'applies the global %s policy to the local runtime',
    async (approvalPolicy) => {
      const { server, port } = setup();
      const setApprovalPolicy = jest.spyOn(port, 'setApprovalPolicy');
      await expect(
        server.request('thread/approvalPolicy/set', { approvalPolicy }),
      ).resolves.toEqual({ ok: true });
      expect(setApprovalPolicy).toHaveBeenCalledWith(approvalPolicy);
    },
  );

  it.each([
    'thread/start',
    'bridge/thread/create',
    'thread/resume',
    'turn/start',
    'bridge/thread/queue/send',
  ])('honors approval policy supplied through %s', async (method) => {
    const { server, port } = setup();
    const threadId = await createChat(server);
    const policy = { approvalPolicy: 'never' };
    const params =
      method === 'bridge/thread/create'
        ? { threadStart: { cwd: DEMO, ...policy }, submissionId: 'policy-create' }
        : method === 'bridge/thread/queue/send'
          ? { threadId, content: 'Hello', turnStart: policy }
          : { threadId, cwd: DEMO, input: [{ type: 'text', text: 'Hello' }], ...policy };
    await server.request(method, params);
    expect(port.approvalPolicy).toBe('never');
    server.stop();
  });

  it.each([undefined, null, '', 'invalid', 'NEVER', true])(
    'rejects invalid global approval policy %s',
    async (approvalPolicy) => {
      const { server } = setup();
      await expect(
        server.request('thread/approvalPolicy/set', { approvalPolicy }),
      ).rejects.toMatchObject({ code: -32602 });
    },
  );

  it('advertises a single local agent and hides unsupported affordances', async () => {
    const { server } = setup();
    const capabilities = (await server.request('bridge/capabilities/read')) as {
      agents: { agentId: string }[];
      supports: Record<string, boolean>;
    };
    expect(capabilities.agents.map((agent) => agent.agentId)).toEqual([LOCAL_AGENT_ID]);
    expect(capabilities.supports).toMatchObject({
      turnSteer: false,
      threadFork: false,
      planMode: false,
      browserPreview: false,
      genericUiSurface: false,
      threadDelete: true,
    });
  });

  it.each([
    'bridge/push/register',
    'bridge/thread/fork',
    'thread/snapshot/page',
    'bridge/browser/session/create',
    'bridge/ui/present',
    'bridge/userInput/resolve',
  ])('rejects %s as unsupported on this iPhone instead of crashing', async (method) => {
    const { server } = setup();
    const error = await rpcError(server.request(method, {}));
    expect(error.code).toBe(-32601);
    expect(error.data).toEqual({ error: 'unsupported_on_device', method });
    expect(LOCAL_IMPLEMENTED_METHODS).not.toContain(method);
  });

  it('answers the shell retry action with the same method name', () => {
    expect(LOCAL_TURN_RETRY_METHOD).toBe(TURN_RETRY_METHOD);
    expect(LOCAL_IMPLEMENTED_METHODS).toContain(TURN_RETRY_METHOD);
  });

  it('creates chats in the requested workspace and model, idempotently per submission', async () => {
    const { server, port, notifications } = setup();
    const first = await createChat(server);
    const retry = await createChat(server);
    expect(retry).toBe(first);
    expect(port.calls.filter((call) => call.startsWith('create:'))).toEqual([
      'create:ws-one:qwen3-1.7b-q4-k-m',
    ]);
    expect(notifications.map((entry) => entry.method)).toEqual(['thread/started']);
  });

  it('falls back to the remembered workspace when the composer sends a desktop path', async () => {
    const { server, port } = setup();
    port.workspaceList = [
      { id: 'ws-one', name: 'Demo', isRepository: true },
      { id: 'ws-two', name: 'Other', isRepository: true },
    ];
    port.defaultValues = { workspaceId: 'ws-two', modelId: null };
    await server.request('thread/start', { cwd: '/Users/ada/desktop-repo' });
    expect(port.calls).toContain('create:ws-two:qwen3-1.7b-q4-k-m');
  });

  it('explains what is missing before a first chat can start', async () => {
    const { server, port } = setup();
    port.models = [];
    expect((await rpcError(createChat(server))).data.error).toBe('on_device_model_required');
    port.models = new FakeAgentPort().models;
    port.workspaceList = [];
    const error = await rpcError(server.request('thread/start', {}));
    expect(error.data.error).toBe('on_device_workspace_required');
    expect(error.message).toMatch(/Create or clone a workspace/u);
  });

  it('projects local threads into bridge snapshots the shared mapper understands', async () => {
    const { server, port } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Read the README',
      turnStart: { cwd: DEMO },
    });
    port.streamAssistant(threadId, 'assistant-1', '', 'Thinking about files');
    port.startTool(threadId, 'assistant-1', 'call-1', 'read_file', '{"path":"README.md"}');
    port.finishTool(threadId, 'call-1', '{"content":"hello"}', 'completed');
    port.streamAssistant(threadId, 'assistant-2', 'It says hello.');
    port.settle(threadId, 'complete');

    const { thread } = (await server.request('thread/read', { threadId, includeTurns: true })) as {
      thread: unknown;
    };
    const chat = mapChat(toRawThread(thread));
    expect(chat.title).toBe('Read the README');
    expect(chat.cwd).toBe(DEMO);
    expect(chat.agentId).toBe(LOCAL_AGENT_ID);
    // The bridge reports no lifecycle for settled threads; only failures and live runs show.
    expect(chat.status).toBe('idle');
    expect(chat.messages.map((message) => [message.role, message.id])).toEqual([
      ['user', 'user-submit-1'],
      ['reasoning', 'assistant-1::reasoning'],
      ['tool', 'tool:call-1'],
      ['assistant', 'assistant-2'],
    ]);
    expect(chat.messages[2]?.toolMeta).toMatchObject({
      kind: 'read',
      status: 'completed',
      title: 'Read README.md',
    });
    expect(chat.acpConfig?.[0]).toMatchObject({
      id: 'model',
      category: 'model',
      value: 'qwen3-1.7b-q4-k-m',
    });

    const list = (await server.request('thread/list', { limit: 10 })) as { data: unknown[] };
    expect(list.data).toHaveLength(1);
  });

  it('streams a turn as AG-UI events that end with RUN_FINISHED', async () => {
    const { server, port, events } = setup();
    const threadId = await createChat(server);
    const response = (await server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Hello',
      turnStart: {},
    })) as { disposition: string; turnId: string };
    expect(response).toMatchObject({
      disposition: 'sent',
      turnId: port.thread(threadId)?.activeTurnId,
    });
    expect(response.turnId).toMatch(/^turn-/u);

    port.streamAssistant(threadId, 'assistant-1', 'Hel', 'Plan');
    port.streamAssistant(threadId, 'assistant-1', 'Hello there', 'Plan more');
    port.startTool(threadId, 'assistant-1', 'call-1', 'write_file', '{"path":"a.txt"}');
    port.finishTool(threadId, 'call-1', '{"ok":true}', 'completed');
    port.settle(threadId, 'complete');

    expect(events().map((event) => event.type)).toEqual([
      // "Preparing" is reported while the model loads, before the message starts the run.
      EventType.CUSTOM,
      EventType.RUN_STARTED,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.CUSTOM,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.CUSTOM,
      EventType.CUSTOM,
      EventType.CUSTOM,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      // "Saving": the loop persists the turn before it settles, as the real runtime does.
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);
    const deltas = events()
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event.type === EventType.TEXT_MESSAGE_CONTENT ? event.delta : ''));
    expect(deltas.join('')).toBe('Hello there');
    const start = events().find((event) => event.type === EventType.TOOL_CALL_START);
    expect(start).toMatchObject({ toolCallId: 'call-1', toolCallName: 'Write a.txt' });
  });

  it('names each phase of a run as activity: loading progress, generating, and the tool', async () => {
    const { server, port, events, notifications } = setup();
    const threadId = await createChat(server);
    // As in the real loop, the model loads before the user message is recorded.
    port.holdModelLoad = true;
    const sent = server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Hello',
      turnStart: {},
    });
    await tick();
    expect(port.thread(threadId)?.status).toBe('idle');
    // No run exists until the message is recorded; the load is reported as activity for that turn.
    expect(events().map((event) => event.type)).toEqual([EventType.CUSTOM]);
    port.setModel({ phase: 'loading', modelId: 'qwen3-1.7b-q4-k-m', progress: 12.6 });
    port.setModel({ progress: 12.9 });
    port.setModel({ progress: 57 });
    port.setModel({ phase: 'ready', progress: 100 });
    port.finishModelLoad();
    const response = (await sent) as { turnId: string };
    const started = events().filter((event) => event.type === EventType.RUN_STARTED);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ runId: `${threadId}::turn::${response.turnId}` });
    const loadingEnvelope = notifications.find((entry) => entry.method === 'bridge/agui.event');
    expect(loadingEnvelope?.params).toMatchObject({
      runId: `${threadId}::turn::${response.turnId}`,
      sourceTurnId: response.turnId,
    });
    port.streamAssistant(threadId, 'assistant-1', 'Reading');
    port.startTool(threadId, 'assistant-1', 'call-1', 'read_file', '{"path":"src/app.ts"}');
    port.finishTool(threadId, 'call-1', '{"content":"x"}', 'completed');
    port.streamAssistant(threadId, 'assistant-2', 'Done.');
    port.settle(threadId, 'complete');

    const activity = events().flatMap((event) =>
      event.type === EventType.CUSTOM && event.name === RUN_ACTIVITY_EVENT_NAME
        ? [event.value as RunActivity]
        : [],
    );
    expect(activity).toEqual([
      { title: 'Preparing' },
      { title: 'Loading Qwen3 1.7B', detail: '12%' },
      { title: 'Loading Qwen3 1.7B', detail: '57%' },
      { title: 'Preparing' },
      { title: 'Generating' },
      { title: 'Reading src/app.ts' },
      { title: 'Generating' },
      { title: 'Saving' },
    ]);
    expect(events().at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('reports a failed or stopped model load without starting or ending a run', async () => {
    const { server, port, events } = setup();
    const threadId = await createChat(server);
    port.holdModelLoad = true;
    const failed = server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Hello',
      turnStart: {},
    });
    await tick();
    port.setModel({ phase: 'loading', modelId: 'qwen3-1.7b-q4-k-m', progress: 30 });
    port.failModelLoad('Not enough memory to load Qwen3 1.7B.');
    // The rejected send carries the failure, so the shell keeps the unsent draft.
    await expect(failed).rejects.toThrow('Not enough memory');
    expect(events().map((event) => event.type)).toEqual([EventType.CUSTOM, EventType.CUSTOM]);
    expect(events()[1]).toMatchObject({ value: { title: 'Loading Qwen3 1.7B', detail: '30%' } });
    expect(port.thread(threadId)?.messages).toEqual([]);

    const before = events().length;
    port.setModel({ phase: 'loading', progress: 10 });
    const stopped = server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-2',
      content: 'Again',
      turnStart: {},
    });
    await tick();
    await server.request('turn/interrupt', { threadId });
    await expect(stopped).rejects.toMatchObject({ data: { error: 'on_device_interrupted' } });
    const later = events().slice(before);
    expect(later.map((event) => event.type)).toEqual([EventType.CUSTOM, EventType.CUSTOM]);
    expect(later[1]).toMatchObject({ value: { title: 'Cancelling model load' } });
    expect(port.thread(threadId)?.messages).toEqual([]);
  });

  it('continues a failed turn in place through bridge/turn/retry', async () => {
    const { server, port, events } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Add a license',
      turnStart: {},
    });
    port.settle(threadId, 'failed', 'The local context window is full.');

    const { thread } = (await server.request('thread/read', { threadId, includeTurns: true })) as {
      thread: unknown;
    };
    const failed = mapChat(toRawThread(thread));
    expect(failed.status).toBe('error');
    expect(failed.lastError).toBe('The local context window is full.');

    const response = (await server.request(LOCAL_TURN_RETRY_METHOD, { threadId })) as {
      turn: { id: string };
    };
    expect(response.turn.id).toBe(port.thread(threadId)?.activeTurnId);
    expect(port.calls).toContain(`retry:${threadId}`);
    expect(
      port.thread(threadId)?.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    const runs = events().filter((event) => event.type === EventType.RUN_STARTED);
    expect(runs).toHaveLength(2);

    const busy = await rpcError(server.request(LOCAL_TURN_RETRY_METHOD, { threadId }));
    expect(busy.data.error).toBe('on_device_busy');
    port.settle(threadId, 'complete');
    const nothing = await rpcError(server.request(LOCAL_TURN_RETRY_METHOD, { threadId }));
    expect(nothing.code).toBe(-32602);
  });

  it('titles local tools with their subject and marks interrupted ones as interrupted', async () => {
    expect(describeLocalTool('search_files', '{"query":"TODO"}')).toEqual({
      kind: 'search',
      title: 'Search “TODO”',
      activity: 'Searching “TODO”',
    });
    expect(describeLocalTool('list_directory', '{"path":"."}').title).toBe('List workspace root');
    expect(describeLocalTool('custom_tool', null)).toMatchObject({
      activity: 'Running custom tool',
    });

    const { server, port, events } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', { threadId, content: 'Edit it' });
    port.streamAssistant(threadId, 'assistant-1', '');
    port.startTool(threadId, 'assistant-1', 'call-1', 'edit_file', '{"path":"src/app.ts"}');
    const tool = port.thread(threadId)?.messages.find((message) => message.tool);
    port.put({
      ...port.thread(threadId)!,
      messages: port
        .thread(threadId)!
        .messages.map((message) =>
          message.id === tool?.id && message.tool
            ? { ...message, tool: { ...message.tool, status: 'interrupted' as const } }
            : message,
        ),
    });
    await port.stop();
    const { thread } = (await server.request('thread/read', { threadId })) as { thread: unknown };
    // Like the Rust bridge, the wire keeps `failed` so installed clients never show `pending`.
    expect((thread as { acpSnapshot: { tools: unknown[] } }).acpSnapshot.tools[0]).toMatchObject({
      status: 'failed',
      interrupted: true,
    });
    const liveMeta = events()
      .filter((event) => event.type === EventType.CUSTOM && event.name === TOOL_META_EVENT_NAME)
      .map((event) => (event as { value: Record<string, unknown> }).value)
      .at(-1);
    expect(liveMeta).toMatchObject({ toolCallId: 'call-1', status: 'failed', interrupted: true });
    const chat = mapChat(toRawThread(thread));
    expect(chat.messages.find((message) => message.role === 'tool')?.toolMeta).toMatchObject({
      title: 'Edit src/app.ts',
      status: 'interrupted',
    });
  });

  it('streams after many tools without re-parsing their arguments on each flush', async () => {
    const { server, port, events } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', { threadId, content: 'Write files' });
    const marker = '/*whole-file*/';
    for (let index = 1; index <= 10; index += 1) {
      port.streamAssistant(threadId, `assistant-${String(index)}`, '');
      port.startTool(
        threadId,
        `assistant-${String(index)}`,
        `call-${String(index)}`,
        'write_file',
        JSON.stringify({ path: `f${String(index)}.ts`, content: `${marker}${'x'.repeat(5000)}` }),
      );
      port.finishTool(threadId, `call-${String(index)}`, '{"ok":true}', 'completed');
    }
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const before = events().length;
      for (const text of ['All', 'All files', 'All files written.']) {
        port.streamAssistant(threadId, 'answer', text);
      }
      expect(
        events()
          .slice(before)
          .map((event) => event.type),
      ).toEqual([
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        // The run's activity changes from the last tool to generating.
        EventType.CUSTOM,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
      ]);
      const parsed = parse.mock.calls.filter(
        ([text]) => typeof text === 'string' && text.includes(marker),
      );
      expect(parsed).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
    port.settle(threadId, 'complete');
    expect(events().at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('stops the active turn and reports it as an interrupted run', async () => {
    const { server, port, events } = setup();
    const threadId = await createChat(server);
    const { turnId } = (await server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Long task',
    })) as { turnId: string };
    port.streamAssistant(threadId, 'assistant-1', 'Working');

    await server.request('turn/interrupt', { threadId, turnId });

    expect(port.calls).toContain('stop');
    const last = events().at(-1);
    expect(last).toMatchObject({ type: EventType.RUN_ERROR, code: 'interrupted' });
    expect(events().filter((event) => event.type === EventType.TEXT_MESSAGE_END)).toHaveLength(1);
    expect(port.thread(threadId)?.status).toBe('interrupted');
  });

  it('reports a failed run after acceptance as RUN_ERROR without failing the send', async () => {
    const { server, port, events } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', {
      threadId,
      submissionId: 'submit-1',
      content: 'Hi',
    });
    port.settle(threadId, 'failed', 'The local model could not load.');
    await Promise.resolve();
    expect(events().at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: 'The local model could not load.',
      code: 'on_device_run_failed',
    });
  });

  it('surfaces a tool approval as a bridge approval and resolves it', async () => {
    const { server, port, notifications } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', { threadId, content: 'Push it' });
    port.requestApproval(threadId, 'call-push', 'git_push', 'Push the current branch to origin');

    const requested = notifications.find((entry) => entry.method === 'bridge/approval.requested');
    expect(requested?.params).toMatchObject({
      requestId: 'call-push',
      threadId,
      title: 'Push the current branch to origin',
      options: [{ id: 'allow-once' }, { id: 'reject-once' }],
    });
    // The shell drops approvals it cannot parse, which would leave the run waiting forever.
    expect(toPendingApproval(requested?.params)).toMatchObject({
      requestId: 'call-push',
      kind: 'commandExecution',
      command: 'Push the current branch to origin',
    });
    expect(await server.request('bridge/approvals/list')).toEqual([requested?.params]);
    await expect(
      server.request('bridge/approvals/resolve', { id: 'call-push', decision: 'maybe' }),
    ).rejects.toMatchObject({ code: -32602 });

    await server.request('bridge/approvals/resolve', {
      id: 'call-push',
      decision: 'reject-once',
      resolutionId: 'r1',
    });
    expect(port.approvals).toEqual([{ callId: 'call-push', approved: false }]);
    expect(notifications.at(-1)).toEqual({
      method: 'bridge/approval.resolved',
      params: { id: 'call-push', threadId },
    });
    expect(await server.request('bridge/approvals/list')).toEqual([]);
    await expect(
      server.request('bridge/approvals/resolve', { id: 'call-push', decision: 'allow-once' }),
    ).rejects.toMatchObject({ code: -32004 });
  });

  it('maps typed native and offline failures to stable reasons', async () => {
    const { server, port } = setup();
    port.git.status = () =>
      Promise.reject(new OnDeviceNativeError('GIT_NOT_REPOSITORY', 'This workspace has no Git.'));
    expect((await rpcError(server.request('bridge/git/status', { cwd: DEMO }))).data).toEqual({
      error: 'on_device_not_repository',
      nativeCode: 'GIT_NOT_REPOSITORY',
    });
    port.git.push = () => Promise.reject(new OnDeviceOfflineError('push'));
    expect((await rpcError(server.request('bridge/git/push', { cwd: DEMO }))).data.error).toBe(
      'on_device_offline',
    );
  });

  it('rejects a send that the runtime refuses before accepting it', async () => {
    const { server, port } = setup();
    const threadId = await createChat(server);
    port.sendError = new Error('Wait for on-device operations to settle before sending.');
    const error = await rpcError(
      server.request('bridge/thread/queue/send', { threadId, submissionId: 's', content: 'Hi' }),
    );
    expect(error.message).toBe('Wait for on-device operations to settle before sending.');
  });

  it('does not start a second chat while another one is running', async () => {
    const { server } = setup();
    const busy = await createChat(server, 'one');
    const idle = await createChat(server, 'two');
    await server.request('bridge/thread/queue/send', { threadId: busy, content: 'one' });
    const error = await rpcError(
      server.request('bridge/thread/queue/send', { threadId: idle, content: 'two' }),
    );
    expect(error.data).toMatchObject({ error: 'on_device_busy', threadId: busy });
  });

  it('answers a resubmitted message without starting another run', async () => {
    const { server, port } = setup();
    const threadId = await createChat(server);
    const send = () =>
      server.request('bridge/thread/queue/send', {
        threadId,
        submissionId: 'same',
        content: 'Once',
      });
    await send();
    await send();
    expect(port.calls.filter((call) => call.startsWith('send:'))).toHaveLength(1);
  });

  it('lists downloaded models with load state and marks the model a new chat would use', async () => {
    const { server, port } = setup();
    const second = { ...port.models[0]!, id: 'qwen3-4b-q4-k-m', name: 'Qwen3 4B' };
    port.models = [...port.models, second];
    port.defaultValues = { workspaceId: null, modelId: 'qwen3-4b-q4-k-m' };
    port.loadedModelId = 'qwen3-1.7b-q4-k-m';
    const list = (await server.request('model/list', {})) as {
      data: Record<string, unknown>[];
    };
    expect(list.data).toEqual([
      {
        id: 'qwen3-1.7b-q4-k-m',
        displayName: 'Qwen3 1.7B Q4_K_M',
        description: 'Loaded · 8K context',
        providerId: 'on-device',
        isDefault: false,
      },
      {
        id: 'qwen3-4b-q4-k-m',
        displayName: 'Qwen3 4B Q4_K_M',
        description: 'Loads when you send · up to 8K context',
        providerId: 'on-device',
        isDefault: true,
      },
    ]);
    // The picker names a model exactly as the drawer status, chat header, and Settings do.
    expect(list.data[0]!['displayName']).toBe(localModelDisplayName('qwen3-1.7b-q4-k-m'));
    port.models = [];
    expect(await server.request('model/list', {})).toEqual({ data: [] });
  });

  it('changes a chat model through the model config option and makes it the new-chat default', async () => {
    const { server, port } = setup();
    port.models = [...port.models, { ...port.models[0]!, id: 'qwen3-4b-q4-k-m', name: 'Qwen3 4B' }];
    const threadId = await createChat(server);
    const response = (await server.request('thread/config/set', {
      threadId,
      configId: 'model',
      value: 'qwen3-4b-q4-k-m',
    })) as { thread: { acpSnapshot: { config: { id: string; value: unknown }[] } } };
    expect(port.calls).toContain(`chooseModel:${threadId}:qwen3-4b-q4-k-m`);
    expect(response.thread.acpSnapshot.config.find((option) => option.id === 'model')?.value).toBe(
      'qwen3-4b-q4-k-m',
    );
    const list = (await server.request('model/list', {})) as {
      data: { id: string; isDefault: boolean }[];
    };
    expect(list.data.find((entry) => entry.isDefault)?.id).toBe('qwen3-4b-q4-k-m');
  });

  it('renames, changes model, and deletes chats through thread notifications', async () => {
    const { server, port, notifications } = setup();
    port.models = [...port.models, { ...port.models[0]!, id: 'qwen3-4b-q4-k-m', name: 'Qwen3 4B' }];
    const threadId = await createChat(server);
    await server.request('thread/name/update', { threadId, title: 'Renamed' });
    await server.request('thread/config/set', {
      threadId,
      configId: 'model',
      value: 'qwen3-4b-q4-k-m',
    });
    expect(port.thread(threadId)?.modelId).toBe('qwen3-4b-q4-k-m');
    await expect(
      server.request('thread/config/set', { threadId, configId: 'model', value: 'missing' }),
    ).rejects.toMatchObject({ data: { error: 'on_device_model_required' } });
    await server.request('thread/delete', { threadId });
    expect(notifications.map((entry) => entry.method)).toEqual([
      'thread/started',
      'thread/name/updated',
      'thread/deleted',
    ]);
    expect((await rpcError(server.request('thread/read', { threadId }))).data).toEqual({
      error: 'thread_not_found',
      threadId,
    });
  });

  it('only lets an empty chat move to another workspace', async () => {
    const { server, port } = setup();
    port.workspaceList = [
      { id: 'ws-one', name: 'Demo', isRepository: true },
      { id: 'ws-two', name: 'Demo', isRepository: true },
    ];
    const workspaces = (await server.request('bridge/workspaces/list')) as {
      workspaces: { path: string }[];
    };
    // Every workspace sharing a name carries its own id tag, never "the first one gets it bare".
    expect(workspaces.workspaces.map((workspace) => workspace.path)).toEqual([
      `${DEMO} (ws-one)`,
      `${DEMO} (ws-two)`,
    ]);
    const [first, other] = workspaces.workspaces.map((workspace) => workspace.path);
    const { thread } = (await server.request('thread/start', { cwd: first })) as {
      thread: { id: string };
    };
    const threadId = thread.id;
    expect(port.thread(threadId)?.workspaceId).toBe('ws-one');
    await server.request('thread/resume', { threadId, cwd: other });
    expect(port.thread(threadId)?.workspaceId).toBe('ws-two');
    await server.request('bridge/thread/queue/send', { threadId, content: 'Hi' });
    port.settle(threadId, 'complete');
    await expect(server.request('thread/resume', { threadId, cwd: first })).rejects.toThrow(
      'Start a new chat',
    );
  });

  it('lists local workspaces for the workspace picker', async () => {
    const { server } = setup();
    expect(await server.request('bridge/fs/list', { path: null })).toMatchObject({
      bridgeRoot: LOCAL_WORKSPACE_ROOT,
      path: LOCAL_WORKSPACE_ROOT,
      parentPath: null,
      entries: [{ name: 'Demo', path: DEMO, kind: 'directory', selectable: true, isGitRepo: true }],
    });
    expect(await server.request('bridge/fs/list', { path: DEMO })).toMatchObject({
      path: DEMO,
      parentPath: LOCAL_WORKSPACE_ROOT,
      entries: [],
    });
  });

  it('routes Git requests to the workspace behind the presented path', async () => {
    const { server, port } = setup();
    expect(await server.request('bridge/git/status', { cwd: DEMO })).toMatchObject({
      branch: 'main',
      cwd: DEMO,
    });
    const history = (await server.request('bridge/git/history', { cwd: DEMO, limit: 2 })) as {
      commits: unknown[];
    };
    expect(history.commits).toHaveLength(2);
    expect(await server.request('bridge/git/branches', { cwd: DEMO })).toMatchObject({
      current: 'main',
    });
    await server.request('bridge/git/stage', { cwd: DEMO, path: 'README.md' });
    await server.request('bridge/git/commit', { cwd: DEMO, message: 'Update' });
    expect(port.calls).toEqual(
      expect.arrayContaining([
        'git.stage:["ws-one","README.md"]',
        'git.commit:["ws-one","Update"]',
      ]),
    );
    expect((await rpcError(server.request('bridge/git/status', { cwd: null }))).data.error).toBe(
      'on_device_workspace_required',
    );
    expect((await rpcError(server.request('bridge/git/commit', { cwd: DEMO }))).code).toBe(-32602);
  });

  it('passes Git file paths through exactly and only discards everything on an explicit null', async () => {
    const { server, port } = setup();
    const discard = 'workspace/git/discard';
    await server.request('bridge/git/stage', { cwd: DEMO, path: 'notes.txt ' });
    await server.request('bridge/git/unstage', { cwd: DEMO, path: ' ' });
    await server.request(discard, { cwd: DEMO, path: 'notes.txt ', includeUntracked: true });
    await server.request(discard, { cwd: DEMO, path: '  ', includeUntracked: true });
    await server.request(discard, { cwd: DEMO, path: null, includeUntracked: true });
    expect(port.calls.filter((call) => call.startsWith('git.'))).toEqual([
      'git.stage:["ws-one","notes.txt "]',
      'git.unstage:["ws-one"," "]',
      'git.discard:["ws-one","notes.txt ",true]',
      'git.discard:["ws-one","  ",true]',
      'git.discard:["ws-one",null,true]',
    ]);

    // An empty or missing file path is invalid rather than widening to every file.
    for (const request of [
      server.request('bridge/git/stage', { cwd: DEMO, path: '' }),
      server.request('bridge/git/unstage', { cwd: DEMO }),
      server.request(discard, { cwd: DEMO, path: '', includeUntracked: true }),
    ]) {
      expect((await rpcError(request)).code).toBe(-32602);
    }
    expect(port.calls.filter((call) => call.startsWith('git.'))).toHaveLength(5);
  });

  it('stops publishing after it is stopped', async () => {
    const { server, port, notifications } = setup();
    server.stop();
    await port.createThread('ws-one', 'qwen3-1.7b-q4-k-m');
    expect(notifications).toEqual([]);
  });
});

describe('LocalBridgeServer workspace paths', () => {
  const X = '8F2A0000-0000-4000-8000-000000000001';
  const Y = '3C1B0000-0000-4000-8000-000000000002';
  const path = (segment: string) => `${LOCAL_WORKSPACE_ROOT}/${segment}`;

  function workspacesSetup(workspaces: { id: string; name: string }[]) {
    const context = setup();
    context.port.workspaceList = workspaces.map((entry) => ({ ...entry, isRepository: true }));
    return context;
  }

  async function chatWithMessage(server: LocalBridgeServer, port: FakeAgentPort, cwd: string) {
    const { thread } = (await server.request('thread/start', { cwd })) as {
      thread: { id: string };
    };
    await server.request('bridge/thread/queue/send', { threadId: thread.id, content: 'Hi' });
    port.settle(thread.id, 'complete');
    return thread.id;
  }

  async function startIn(server: LocalBridgeServer, port: FakeAgentPort, cwd: string) {
    const { thread } = (await server.request('thread/start', { cwd })) as {
      thread: { id: string };
    };
    return port.thread(thread.id)?.workspaceId;
  }

  function cwdChanges(notifications: LocalNotification[]) {
    return notifications
      .filter((notification) => notification.method === 'workspace/thread/cwdChanged')
      .map((notification) => notification.params);
  }

  it('never hands a workspace path to another workspace renamed onto its name', async () => {
    const { server, port, notifications } = workspacesSetup([
      { id: X, name: 'app' },
      { id: Y, name: 'scratch' },
    ]);
    await server.request('workspace/select', { cwd: path('app') });
    const threadId = await chatWithMessage(server, port, path('app'));
    expect(port.thread(threadId)?.workspaceId).toBe(X);

    // Renaming the other workspace onto "app" (in any case) is refused instead of taking X's path.
    for (const name of ['app', 'APP ']) {
      const error = await rpcError(
        server.request('workspace/rename', { cwd: path('scratch'), name }),
      );
      expect(error.code).toBe(-32602);
      expect(error.data.error).toBe('on_device_workspace_name_taken');
      expect(error.message).toBe(
        `A workspace named “${name.trim()}” is already on this iPhone. Choose another name.`,
      );
    }
    expect(port.workspaceList.map((workspace) => workspace.name)).toEqual(['app', 'scratch']);
    expect(port.calls.some((call) => call.startsWith('workspace.rename'))).toBe(false);
    expect(cwdChanges(notifications)).toEqual([]);

    // The remembered default, new chats, the open chat, and its Git screen all still reach X.
    expect(await startIn(server, port, path('app'))).toBe(X);
    await expect(
      server.request('thread/resume', { threadId, cwd: path('app') }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
    expect(await server.request('bridge/git/status', { cwd: path('app') })).toMatchObject({
      cwd: path('app'),
    });
    await server.request('bridge/git/commit', { cwd: path('app'), message: 'Update' });
    await server.request('workspace/git/discard', {
      cwd: path('app'),
      path: null,
      includeUntracked: true,
    });
    await server.request('bridge/git/push', { cwd: path('app') });
    expect(port.calls.filter((call) => call.startsWith('git.'))).toEqual([
      `git.commit:["${X}","Update"]`,
      `git.discard:["${X}",null,true]`,
      `git.push:["${X}"]`,
    ]);

    // Renaming a workspace to its own name in another case is not a clash.
    await expect(
      server.request('workspace/rename', { cwd: path('scratch'), name: 'Scratch' }),
    ).resolves.toMatchObject({ path: path('Scratch'), name: 'Scratch' });
  });

  it('presents shared names with every member tagged and refuses to guess between them', async () => {
    const { server, port, notifications } = workspacesSetup([
      { id: X, name: 'app' },
      { id: Y, name: 'scratch' },
    ]);
    const threadId = await chatWithMessage(server, port, path('app'));

    // Names an older build let two workspaces share: neither keeps the bare path.
    port.setWorkspaces([
      { id: X, name: 'app', isRepository: true },
      { id: Y, name: 'App', isRepository: true },
    ]);
    const listed = (await server.request('bridge/workspaces/list')) as {
      workspaces: { path: string }[];
    };
    expect(listed.workspaces.map((workspace) => workspace.path)).toEqual([
      path('app (8f2a00)'),
      path('App (3c1b00)'),
    ]);
    expect(cwdChanges(notifications)).toEqual([{ threadId, cwd: path('app (8f2a00)') }]);

    // The old bare path is ambiguous now, so it fails clearly instead of picking either one.
    for (const request of [
      server.request('thread/start', { cwd: path('app') }),
      server.request('bridge/git/commit', { cwd: path('app'), message: 'Update' }),
      server.request('thread/resume', { threadId, cwd: path('app') }),
    ]) {
      const error = await rpcError(request);
      expect(error.data.error).toBe('on_device_workspace_required');
    }
    expect(port.calls.some((call) => call.startsWith('git.'))).toBe(false);

    // Each tagged path reaches its own workspace, and the open chat works at its pushed path.
    await server.request('bridge/git/commit', { cwd: path('app (8f2a00)'), message: 'X' });
    await server.request('bridge/git/commit', { cwd: path('App (3c1b00)'), message: 'Y' });
    expect(port.calls.filter((call) => call.startsWith('git.'))).toEqual([
      `git.commit:["${X}","X"]`,
      `git.commit:["${Y}","Y"]`,
    ]);
    await expect(
      server.request('thread/resume', { threadId, cwd: path('app (8f2a00)') }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
  });

  it('keeps a chosen duplicate-named workspace reachable after its namesake is deleted', async () => {
    const { server, port, notifications } = workspacesSetup([
      { id: Y, name: 'app' },
      { id: X, name: 'app' },
    ]);
    const paths = localWorkspacePaths(port.workspaces());
    const a = paths.get(Y)!;
    const b = paths.get(X)!;
    await server.request('workspace/select', { cwd: b });
    const threadId = await chatWithMessage(server, port, b);
    expect(port.thread(threadId)?.workspaceId).toBe(X);

    await server.request('workspace/delete', { cwd: a });
    expect(port.workspaceList.map((workspace) => workspace.id)).toEqual([X]);

    // B's remembered path still names B for new chats, the open chat, and Git.
    expect(await startIn(server, port, b)).toBe(X);
    await expect(server.request('thread/resume', { threadId, cwd: b })).resolves.toMatchObject({
      thread: { id: threadId },
    });
    await server.request('bridge/git/commit', { cwd: b, message: 'Update' });
    expect(port.calls).toContain(`git.commit:["${X}","Update"]`);
    // Open chats are told B's simpler path now that its name is unique again.
    expect(cwdChanges(notifications)).toEqual([{ threadId, cwd: path('app') }]);
  });

  it('pushes a renamed workspace path to its open chats, which keep reaching it', async () => {
    const { server, port, notifications } = workspacesSetup([
      { id: X, name: 'app' },
      { id: Y, name: 'scratch' },
    ]);
    const threadId = await chatWithMessage(server, port, path('app'));
    const other = await chatWithMessage(server, port, path('scratch'));

    await expect(
      server.request('workspace/rename', { cwd: path('app'), name: 'web' }),
    ).resolves.toMatchObject({ path: path('web') });
    expect(cwdChanges(notifications)).toEqual([{ threadId, cwd: path('web') }]);
    const summary = (await server.request('thread/read', { threadId, includeTurns: false })) as {
      thread: { cwd: string };
    };
    expect(summary.thread.cwd).toBe(path('web'));

    await expect(
      server.request('thread/resume', { threadId, cwd: path('web') }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
    await server.request('bridge/git/commit', { cwd: path('web'), message: 'Update' });
    expect(port.calls).toContain(`git.commit:["${X}","Update"]`);

    // A new workspace may take the freed name; it never reaches X's chat or Git.
    await server.request('workspace/create', { name: 'app' });
    const created = port.workspaceList.find((workspace) => workspace.name === 'app')!;
    expect(await startIn(server, port, path('app'))).toBe(created.id);
    await server.request('bridge/git/commit', { cwd: path('web'), message: 'Again' });
    expect(port.calls).toContain(`git.commit:["${X}","Again"]`);
    expect(cwdChanges(notifications)).toEqual([{ threadId, cwd: path('web') }]);

    // Deleting a chat's workspace tells it, so it stops targeting any workspace.
    await server.request('workspace/delete', { cwd: path('scratch') });
    expect(cwdChanges(notifications).at(-1)).toEqual({
      threadId: other,
      cwd: path(LOCAL_UNAVAILABLE_WORKSPACE),
    });
  });
});
