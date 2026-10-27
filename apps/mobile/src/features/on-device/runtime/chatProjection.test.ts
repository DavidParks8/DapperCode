import { localChatProjection } from './chatProjection';
import type { LocalThread } from './types';

test('local Git mutations are not presented as read-only tools and settled runs stop loading', () => {
  const thread: LocalThread = {
    version: 1,
    id: 'thread',
    workspaceId: 'workspace',
    modelId: 'model',
    title: 'Local',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    status: 'interrupted',
    activeTurnId: null,
    lastSubmissionId: 'submission',
    lastError: 'Stopped',
    messages: [
      {
        id: 'mutation',
        role: 'tool',
        content: '{"hash":"actual-hash"}',
        createdAt: '2026-01-01T00:00:00Z',
        tool: {
          callId: 'commit',
          name: 'git_commit',
          status: 'completed',
          startedAt: '2026-01-01T00:00:00Z',
        },
      },
      {
        id: 'read',
        role: 'tool',
        content: '{}',
        createdAt: '2026-01-01T00:00:00Z',
        tool: {
          callId: 'status',
          name: 'git_status',
          status: 'interrupted',
          startedAt: '2026-01-01T00:00:00Z',
        },
      },
      {
        id: 'answer',
        role: 'assistant',
        content: 'Partial response',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  const chat = localChatProjection(thread, 'Workspace');
  expect(chat).toMatchObject({
    status: 'idle',
    activeTurnId: null,
    latestTurnStatus: 'interrupted',
    lastError: 'Stopped',
  });
  expect(chat.messages[0]).toMatchObject({
    role: 'tool',
    content: '{"hash":"actual-hash"}',
    toolMeta: { kind: 'other', status: 'completed' },
  });
  expect(chat.messages[1]).toMatchObject({ toolMeta: { kind: 'read', status: 'failed' } });
  expect(chat.messages[2]).toMatchObject({ pending: false });
});
