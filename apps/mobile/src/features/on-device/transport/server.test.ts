import { EventType } from '@ag-ui/core';

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
import { FakeAgentPort } from './testing';
import { describeLocalTool, LOCAL_AGENT_ID, LOCAL_WORKSPACE_ROOT } from './wire';

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
    'bridge/git/clone',
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
    await stopped;
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

    const { server, port } = setup();
    const threadId = await createChat(server);
    await server.request('bridge/thread/queue/send', { threadId, content: 'Edit it' });
    port.streamAssistant(threadId, 'assistant-1', '');
    port.startTool(threadId, 'assistant-1', 'call-1', 'edit_file', '{"path":"src/app.ts"}');
    await port.stop();
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
    const { thread } = (await server.request('thread/read', { threadId })) as { thread: unknown };
    const chat = mapChat(toRawThread(thread));
    expect(chat.messages.find((message) => message.role === 'tool')?.toolMeta).toMatchObject({
      title: 'Edit src/app.ts · Interrupted',
    });
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
    const threadId = await createChat(server);
    const workspaces = (await server.request('bridge/workspaces/list')) as {
      workspaces: { path: string }[];
    };
    const other = workspaces.workspaces[1]!.path;
    expect(other).toBe(`${DEMO} (ws-two)`);
    await server.request('thread/resume', { threadId, cwd: other });
    expect(port.thread(threadId)?.workspaceId).toBe('ws-two');
    await server.request('bridge/thread/queue/send', { threadId, content: 'Hi' });
    port.settle(threadId, 'complete');
    await expect(server.request('thread/resume', { threadId, cwd: DEMO })).rejects.toThrow(
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

  it('stops publishing after it is stopped', async () => {
    const { server, port, notifications } = setup();
    server.stop();
    await port.createThread('ws-one', 'qwen3-1.7b-q4-k-m');
    expect(notifications).toEqual([]);
  });
});
