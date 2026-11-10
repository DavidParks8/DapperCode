import { EventType } from '@ag-ui/core';

import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import { mapChat, toRawThread } from '@bridge/mapping/chatMapping';
import { getSubAgentMeta, getSubAgentThreadId } from '@bridge/messages';
import type { LocalChild, LocalMessage } from '../runtime/types';
import { localChildThreadId } from './children';
import type { LocalNotification } from './events';
import { LocalBridgeServer, LocalRpcError } from './server';
import { FakeAgentPort } from './testing';
import { LOCAL_WORKSPACE_ROOT } from './wire';

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;
const CHILD = localChildThreadId('child-1');
// What the client's chat list sends without and with sub-agents.
const SESSION_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const ALL_KINDS = [
  ...SESSION_KINDS,
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
];

function setup() {
  const port = new FakeAgentPort();
  const server = new LocalBridgeServer(port);
  const notifications: LocalNotification[] = [];
  server.onNotification((notification) => notifications.push(notification));
  server.start();
  return { port, server, notifications };
}

/** Records the task child's new state on the parent's `task` message, as delegation does. */
function putChild(port: FakeAgentPort, parentId: string, child: LocalChild): void {
  const parent = port.thread(parentId)!;
  port.put({
    ...parent,
    messages: parent.messages.map((message) =>
      message.tool?.callId === 'call-task' ? { ...message, children: [child] } : message,
    ),
  });
}

/** A parent chat whose model has just called `task`, as delegation sees it. */
async function delegatingParent(server: LocalBridgeServer, port: FakeAgentPort): Promise<string> {
  const { thread } = (await server.request('bridge/thread/create', {
    submissionId: 'create-1',
    threadStart: { cwd: DEMO, model: 'qwen3-1.7b-q4-k-m' },
  })) as { thread: { id: string } };
  await server.request('bridge/thread/queue/send', {
    threadId: thread.id,
    content: 'Survey the repository',
  });
  port.streamAssistant(thread.id, 'assistant-1', '');
  port.startTool(
    thread.id,
    'assistant-1',
    'call-task',
    'task',
    '{"tasks":[{"agent":"explore","prompt":"Find TODO comments"}]}',
  );
  return thread.id;
}

const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();

const prompt = (id: string, content: string, second: number): LocalMessage => ({
  id: `user-${id}`,
  role: 'user',
  content,
  createdAt: at(second),
});

const admitted: LocalChild = {
  id: 'child-1',
  agent: 'explore',
  workspaceId: 'ws-one',
  modelId: 'qwen3-1.7b-q4-k-m',
  status: 'running',
  updatedAt: at(0),
  lastError: null,
  messages: [],
};

const prompted: LocalChild = {
  ...admitted,
  updatedAt: at(1),
  messages: [prompt('one', 'Find TODO comments', 1)],
};

const searching: LocalChild = {
  ...prompted,
  updatedAt: at(3),
  messages: [
    ...prompted.messages,
    {
      id: 'child-assistant-1',
      role: 'assistant',
      content: 'Searching the sources.',
      createdAt: at(2),
      toolCalls: [
        {
          id: 'child-call-1',
          type: 'function',
          function: { name: 'search_files', arguments: '{"query":"TODO"}' },
        },
      ],
    },
    {
      id: 'tool-child-call-1',
      role: 'tool',
      content: '',
      createdAt: at(3),
      tool: { callId: 'child-call-1', name: 'search_files', status: 'running', startedAt: at(3) },
    },
  ],
};

const completed: LocalChild = {
  ...searching,
  status: 'complete',
  updatedAt: at(5),
  messages: [
    ...searching.messages.map((message) =>
      message.tool
        ? {
            ...message,
            content: 'src/app.ts:3: TODO',
            tool: { ...message.tool, status: 'completed' as const, completedAt: at(4) },
          }
        : message,
    ),
    {
      id: 'child-assistant-2',
      role: 'assistant',
      content: 'Found one TODO\nin src/app.ts.',
      createdAt: at(5),
    },
  ],
};

function agUi(notifications: LocalNotification[], threadId: string) {
  return notifications
    .map((notification) => parseAgUiEventNotification(notification))
    .filter((envelope) => envelope !== null && envelope.threadId === threadId)
    .map((envelope) => envelope!.event);
}

type SubAgentCard = {
  messageId: string;
  content: { text: string; subAgent: Record<string, unknown> };
};

function cardsFor(notifications: LocalNotification[], parentId: string) {
  return agUi(notifications, parentId)
    .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    .map((event) => (event as unknown as SubAgentCard).messageId);
}

function latestCard(notifications: LocalNotification[], parentId: string) {
  const event = agUi(notifications, parentId)
    .filter((entry) => entry.type === EventType.ACTIVITY_SNAPSHOT)
    .at(-1) as unknown as SubAgentCard;
  return event;
}

async function readChat(server: LocalBridgeServer, threadId: string) {
  const { thread } = (await server.request('thread/read', { threadId, includeTurns: true })) as {
    thread: unknown;
  };
  return mapChat(toRawThread(thread));
}

async function rejection(promise: Promise<unknown>): Promise<LocalRpcError> {
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

describe('local task children as ACP sub-agent threads', () => {
  it('lists, reads, and links a running child like an ACP sub-agent session', async () => {
    const { port, server } = setup();
    const parentId = await delegatingParent(server, port);
    putChild(port, parentId, searching);

    const listed = (await server.request('thread/list', {
      sourceKinds: ALL_KINDS,
    })) as { data: unknown[] };
    const summaries = listed.data.map((entry) => mapChat(toRawThread(entry)));
    expect(summaries.map((chat) => chat.id)).toEqual([parentId, CHILD]);
    expect(summaries[1]).toMatchObject({
      parentThreadId: parentId,
      sourceKind: 'subAgentThreadSpawn',
      agentNickname: 'Explore agent',
      agentRole: 'explore',
      title: 'Find TODO comments',
      status: 'running',
      cwd: DEMO,
    });
    const sessions = (await server.request('thread/list', {
      sourceKinds: SESSION_KINDS,
    })) as { data: { id: string }[] };
    expect(sessions.data.map((entry) => entry.id)).toEqual([parentId]);

    const child = await readChat(server, CHILD);
    expect(child).toMatchObject({ id: CHILD, parentThreadId: parentId, status: 'running' });
    expect(child.messages.map((message) => [message.role, message.content])).toEqual(
      expect.arrayContaining([
        ['user', 'Find TODO comments'],
        ['assistant', 'Searching the sources.'],
      ]),
    );
    expect(child.messages.some((message) => message.toolMeta?.title === 'Search “TODO”')).toBe(
      true,
    );

    const parent = await readChat(server, parentId);
    const card = parent.messages.find((message) => getSubAgentThreadId(message) === CHILD);
    expect(card).toBeDefined();
    expect(getSubAgentMeta(card!)).toMatchObject({ agentStatus: 'running' });
  });

  it('streams a child under its own thread while the parent card tracks and links it', async () => {
    const { port, server, notifications } = setup();
    const parentId = await delegatingParent(server, port);
    notifications.length = 0;

    putChild(port, parentId, admitted);
    expect(notifications.find((entry) => entry.method === 'thread/started')).toMatchObject({
      params: {
        threadId: CHILD,
        thread: {
          id: CHILD,
          source: { subAgent: { thread_spawn: { parentThreadId: parentId, depth: 1 } } },
        },
      },
    });
    expect(notifications).toContainEqual({
      method: 'thread/subagent/adopted',
      params: { threadId: CHILD, parentThreadId: parentId },
    });
    expect(latestCard(notifications, parentId)).toMatchObject({
      messageId: `subagent:child:${parentId}:child-1`,
      content: {
        text: '• Sub-agent working\n  Status: running',
        subAgent: { receiverThreadIds: [CHILD], senderThreadId: parentId, agentStatus: 'running' },
      },
    });
    // A child with no prompt yet has no turn to stream.
    expect(agUi(notifications, CHILD)).toEqual([]);

    putChild(port, parentId, prompted);
    expect(notifications).toContainEqual({
      method: 'thread/name/updated',
      params: { threadId: CHILD, threadName: 'Find TODO comments' },
    });
    expect(latestCard(notifications, parentId).content.subAgent).toMatchObject({
      prompt: 'Find TODO comments',
    });
    const [started] = agUi(notifications, CHILD);
    expect(started).toMatchObject({ type: EventType.RUN_STARTED, threadId: CHILD });

    putChild(port, parentId, searching);
    expect(agUi(notifications, CHILD).map((event) => event.type)).toEqual(
      expect.arrayContaining([EventType.TEXT_MESSAGE_CONTENT, EventType.TOOL_CALL_START]),
    );
    expect(latestCard(notifications, parentId).content.text).toBe(
      '• Sub-agent working\n  Status: running\n  Latest: Search “TODO”',
    );

    putChild(port, parentId, completed);
    expect(agUi(notifications, CHILD).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect(latestCard(notifications, parentId)).toMatchObject({
      content: {
        text: '• Sub-agent completed\n  Status: completed\n  Latest: Found one TODO in src/app.ts.',
        subAgent: { agentStatus: 'completed' },
      },
    });
    // The card the parent's history maps to is the same card the live stream updated.
    const parent = await readChat(server, parentId);
    const card = parent.messages.find((message) => getSubAgentThreadId(message) === CHILD);
    expect(card?.id).toBe(`subagent:child:${parentId}:child-1`);
    expect(getSubAgentMeta(card!)).toMatchObject({ agentStatus: 'completed' });
    expect(new Set(cardsFor(notifications, parentId))).toEqual(new Set([card?.id]));

    // Resuming the child with a new prompt is a new run of the same thread.
    const firstRun = (started as { runId: string }).runId;
    notifications.length = 0;
    putChild(port, parentId, {
      ...completed,
      status: 'running',
      updatedAt: at(6),
      messages: [...completed.messages, prompt('two', 'Now count them', 6)],
    });
    const resumed = agUi(notifications, CHILD).find(
      (event) => event.type === EventType.RUN_STARTED,
    ) as { runId: string } | undefined;
    expect(resumed?.runId).toBeDefined();
    expect(resumed?.runId).not.toBe(firstRun);
    expect(notifications.some((entry) => entry.method === 'thread/started')).toBe(false);
  });

  it('keeps a child read-only and removes it with its parent', async () => {
    const { port, server, notifications } = setup();
    const parentId = await delegatingParent(server, port);
    putChild(port, parentId, completed);
    const before = port.thread(parentId);

    for (const [method, params] of [
      ['turn/start', { threadId: CHILD, input: [{ type: 'text', text: 'More' }] }],
      ['bridge/thread/queue/send', { threadId: CHILD, content: 'More' }],
      ['thread/resume', { threadId: CHILD, cwd: DEMO }],
      ['thread/name/update', { threadId: CHILD, title: 'Renamed' }],
      ['thread/delete', { threadId: CHILD }],
      ['turn/interrupt', { threadId: CHILD }],
    ] as const) {
      const error = await rejection(server.request(method, params));
      expect(error.data).toEqual({ error: 'on_device_subagent_read_only', threadId: CHILD });
    }
    expect(port.thread(parentId)).toBe(before);
    const missing = await rejection(
      server.request('thread/read', { threadId: localChildThreadId('gone') }),
    );
    expect(missing.data).toMatchObject({ error: 'thread_not_found' });

    notifications.length = 0;
    await server.request('thread/delete', { threadId: parentId });
    const deleted = notifications
      .filter((entry) => entry.method === 'thread/deleted')
      .map((entry) => (entry.params as { threadId: string }).threadId);
    expect(deleted).toEqual(expect.arrayContaining([parentId, CHILD]));
    await expect(rejection(server.request('thread/read', { threadId: CHILD }))).resolves.toThrow(
      'Thread not found',
    );
  });

  it('lists children in the drawer stream only when sub-agents are requested', async () => {
    const { port, server, notifications } = setup();
    const parentId = await delegatingParent(server, port);
    putChild(port, parentId, completed);
    const batches = async (includeSubAgents: boolean) => {
      notifications.length = 0;
      const streamId = `stream-${String(includeSubAgents)}`;
      await server.request('bridge/thread/list/stream/start', { streamId, includeSubAgents });
      await Promise.resolve();
      const batch = notifications.find(
        (entry) => entry.method === 'bridge/thread/list/stream/batch',
      );
      return (batch?.params as { data: { id: string }[] }).data.map((entry) => entry.id);
    };
    await expect(batches(true)).resolves.toEqual([parentId, CHILD]);
    await expect(batches(false)).resolves.toEqual([parentId]);
  });
});
