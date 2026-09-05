import { HostBridgeApiClient } from './client';
import type { RawAcpSnapshot } from '@bridge/mapping/chatMapping';
import { getMessageText } from '@bridge/messages';
import type { HostBridgeWsClient } from '@bridge/ws/ws';

const threadId = 'opencode:locked-turn';
const prompt = 'Finish the task while my phone is locked.';
const answer = 'The background task is complete.';

function snapshot(messages: RawAcpSnapshot['messages'], reconstructing = false): RawAcpSnapshot {
  return {
    version: 2,
    messages,
    tools: [],
    plan: [],
    usage: {},
    config: [],
    commands: [],
    session: { agentId: 'opencode', threadId, historyReconstruction: reconstructing },
    active: { toolIds: [] },
  };
}

const user = {
  id: 'user',
  role: 'user',
  parts: [{ type: 'text', text: prompt }],
  truncated: false,
};
const assistant = {
  id: 'answer',
  role: 'agent',
  parts: [{ type: 'text', text: answer }],
  truncated: false,
};

function createClient() {
  const request = jest.fn();
  const client = new HostBridgeApiClient({
    ws: { request } as unknown as HostBridgeWsClient,
  });
  return { client, request };
}

describe('history recovery through the shared client cache', () => {
  it('preserves the sent message and derived title through incomplete reads and reopening', async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce({
      thread: { id: threadId, acpSnapshot: snapshot([user]) },
    });
    const initial = await client.getChat(threadId);
    expect(initial.title).toBe(prompt);
    expect(initial.messages.map(getMessageText)).toEqual([prompt]);

    request.mockResolvedValue({
      thread: { id: threadId, acpSnapshot: snapshot([]) },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recovered = await client.getChat(threadId, { forceRefresh: true });
      expect(recovered.messages.map(getMessageText)).toEqual([prompt]);
      expect(recovered.title).toBe(initial.title);
      expect(recovered).toHaveProperty('historyRecoveryError', expect.any(String));
      expect(client.peekChat(threadId)).toEqual(recovered);
      expect(client.peekChatShell(threadId)?.messages.map(getMessageText)).toEqual([prompt]);
      expect((await client.getChatSummary(threadId)).title).toBe(initial.title);
    }

    request.mockResolvedValue({
      thread: { id: threadId, name: 'Finished task', acpSnapshot: snapshot([user, assistant]) },
    });
    const complete = await client.getChat(threadId, { forceRefresh: true });
    expect(complete.messages.map(getMessageText)).toEqual([prompt, answer]);
    expect(complete.title).toBe('Finished task');
    expect(complete).toHaveProperty('historyRecoveryError', null);
    expect(client.peekChat(threadId)).toEqual(complete);
    expect((await client.getChat(threadId)).messages.map(getMessageText)).toEqual([prompt, answer]);
  });

  it('does not classify a genuinely new empty chat as missing history', async () => {
    const { client, request } = createClient();
    request.mockResolvedValue({ thread: { id: threadId, acpSnapshot: snapshot([]) } });
    const empty = await client.getChat(threadId);
    expect(empty.messages).toEqual([]);
    expect(empty).toHaveProperty('historyRecoveryError', null);
  });

  it('marks reconstruction explicitly without requiring previously cached history', async () => {
    const { client, request } = createClient();
    request.mockResolvedValue({
      thread: { id: threadId, acpSnapshot: snapshot([], true) },
    });

    expect(await client.getChat(threadId)).toHaveProperty(
      'historyRecoveryError',
      expect.any(String),
    );
  });

  it('retains a completed answer when reconstruction returns only its user prompt', async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce({
      thread: { id: threadId, acpSnapshot: snapshot([user, assistant]) },
    });
    await client.getChat(threadId);
    request.mockResolvedValueOnce({ thread: { id: threadId, acpSnapshot: snapshot([user]) } });
    const incomplete = await client.getChat(threadId);
    expect(incomplete.messages.map(getMessageText)).toEqual([prompt, answer]);
    expect(incomplete.historyRecoveryError).toBeTruthy();
    expect(client.peekChat(threadId)).toEqual(incomplete);
  });

  it('keeps activity-only reconstruction marked incomplete without discarding the activity', async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce({
      thread: { id: threadId, acpSnapshot: snapshot([user, assistant]) },
    });
    await client.getChat(threadId);
    request.mockResolvedValueOnce({
      thread: {
        id: threadId,
        acpSnapshot: snapshot([
          {
            id: 'agent-message',
            role: 'agent',
            parts: [{ type: 'text', text: 'Child update' }],
            truncated: false,
            agentMessage: {
              messageId: 'agent-message',
              direction: 'received',
              relatedThreadId: 'child',
              relatedTitle: 'Child',
              relation: 'sub_agent',
              disposition: 'sent',
              body: 'Child update',
            },
          },
        ]),
      },
    });
    const incomplete = await client.getChat(threadId);
    expect(incomplete.messages.map(getMessageText)).toEqual([prompt, answer, 'Child update']);
    expect(incomplete.historyRecoveryError).toBeTruthy();
  });

  it('keeps a real rename even while history is unavailable and forgets deleted history', async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce({
      thread: { id: threadId, acpSnapshot: snapshot([user, assistant]) },
    });
    await client.getChat(threadId);
    request.mockResolvedValue({
      thread: { id: threadId, name: 'Renamed chat', acpSnapshot: snapshot([]) },
    });
    const incomplete = await client.getChat(threadId);
    expect(incomplete.title).toBe('Renamed chat');
    expect(incomplete.messages.map(getMessageText)).toEqual([prompt, answer]);
    client.forgetChat(threadId);
    expect(client.peekChat(threadId)).toBeNull();
  });
});
