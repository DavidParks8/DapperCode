import { HostBridgeApiClient } from '@bridge/client/client';
import { RpcRequestError } from '@bridge/ws/errors';
import { LocalBridgeServer } from '../../features/on-device/transport/server';
import { FakeAgentPort } from '../../features/on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../features/on-device/transport/wire';
import { LocalBridgeWsClient } from './LocalBridgeWsClient';

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

function setup() {
  const port = new FakeAgentPort();
  const ws = new LocalBridgeWsClient(new LocalBridgeServer(port));
  const statuses: boolean[] = [];
  ws.onStatus((connected) => statuses.push(connected));
  ws.connect();
  const api = new HostBridgeApiClient({ ws, profileId: 'on-device' });
  return { port, ws, api, statuses };
}

describe('LocalBridgeWsClient with the unchanged HostBridgeApiClient', () => {
  it('is connected without a socket and ignores background disconnects', () => {
    const { ws, statuses } = setup();
    expect(ws.isConnected).toBe(true);
    ws.disconnect();
    expect(ws.isConnected).toBe(true);
    expect(ws.notify('bridge/push/presence', {})).toBe(false);
    expect(statuses).toEqual([true]);
  });

  it('creates a chat, sends the first message, and streams the run to completion', async () => {
    const { api, ws, port } = setup();
    const events: string[] = [];
    ws.onEvent((event) => events.push(event.method));

    const created = await api.createChatIdempotent(
      { cwd: DEMO, model: 'qwen3-1.7b-q4-k-m', agentId: 'on-device' },
      'submission-create',
    );
    expect(created).toMatchObject({ cwd: DEMO, agentId: 'on-device' });

    let startedTurn: string | null = null;
    const sent = await api.sendChatMessageIdempotent(
      created.id,
      { content: 'Summarize the README', cwd: DEMO },
      'submission-send',
      { onTurnStarted: (turnId) => (startedTurn = turnId) },
    );
    expect(startedTurn).toMatch(/^turn-/u);
    expect(sent.status).toBe('running');
    expect(sent.messages.map((message) => message.content)).toContain('Summarize the README');

    const completion = ws.waitForTurnCompletion(created.id, startedTurn!, 1_000);
    port.streamAssistant(created.id, 'assistant-1', 'It describes the app.');
    port.settle(created.id, 'complete');
    await expect(completion).resolves.toBeUndefined();
    expect(events).toContain('bridge/agui.event');

    const reloaded = await api.getChat(created.id, { forceRefresh: true });
    expect(reloaded.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Summarize the README'],
      ['assistant', 'It describes the app.'],
    ]);
    const listed = await api.listAllChats({ forceRefresh: true });
    expect(listed.chats.map((chat) => chat.title)).toEqual(['Summarize the README']);
  });

  it('stops the latest active turn and reports it as interrupted', async () => {
    const { api, ws } = setup();
    const chat = await api.createChatIdempotent({ cwd: DEMO }, 'create');
    await api.sendChatMessageIdempotent(chat.id, { content: 'Long', cwd: DEMO }, 'send');
    const completion = ws.waitForTurnCompletion(
      chat.id,
      (await api.getChat(chat.id)).activeTurnId!,
    );
    await expect(api.interruptLatestTurn(chat.id)).resolves.toMatch(/^turn-/u);
    await expect(completion).rejects.toThrow('Stopped');
  });

  it('renames and deletes chats through the existing drawer API', async () => {
    const { api, port } = setup();
    const chat = await api.createChatIdempotent({ cwd: DEMO }, 'create');
    await expect(api.renameChat(chat.id, 'Release notes')).resolves.toMatchObject({
      title: 'Release notes',
    });
    await api.deleteChat(chat.id);
    expect(port.thread(chat.id)).toBeNull();
  });

  it('lists downloaded models, local workspaces, and Git state through API helpers', async () => {
    const { api } = setup();
    await expect(api.listModelOptions('on-device')).resolves.toEqual([
      expect.objectContaining({ id: 'qwen3-1.7b-q4-k-m', displayName: 'Qwen3 1.7B · Q4_K_M' }),
    ]);
    await expect(api.listWorkspaceRoots()).resolves.toMatchObject({
      bridgeRoot: LOCAL_WORKSPACE_ROOT,
      workspaces: [{ path: DEMO, chatCount: 0 }],
    });
    await expect(api.gitStatus(DEMO)).resolves.toMatchObject({ branch: 'main', clean: false });
    await expect(api.gitDiff(DEMO)).resolves.toMatchObject({ truncated: false });
    await expect(api.gitHistory(DEMO, 1)).resolves.toMatchObject({ commits: [{ hash: 'hash-1' }] });
    await expect(api.gitBranches(DEMO)).resolves.toMatchObject({ current: 'main' });
    await expect(api.gitCommit({ cwd: DEMO, message: 'Ship it' })).resolves.toMatchObject({
      committed: true,
    });
  });

  it('surfaces unsupported bridge features as typed RPC errors', async () => {
    const { api } = setup();
    const error: unknown = await api
      .forkChat('thread', 'message')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RpcRequestError);
    expect(error).toMatchObject({
      code: -32601,
      data: { error: 'unsupported_on_device', method: 'bridge/thread/fork' },
    });
  });

  it('stops delivering events and requests once disposed', async () => {
    const { api, ws, port, statuses } = setup();
    const events: string[] = [];
    ws.onEvent((event) => events.push(event.method));
    ws.dispose();
    ws.dispose();
    await port.createThread('ws-one', 'qwen3-1.7b-q4-k-m');
    expect(events).toEqual([]);
    expect(statuses).toEqual([true, false]);
    await expect(api.listModelOptions('on-device')).rejects.toThrow('no longer active');
  });
});
