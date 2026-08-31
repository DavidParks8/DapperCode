import { expect, test } from '@playwright/test';

import { startRealBridge } from '../harness/realBridge.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

test.describe('production bridge workflows', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'phone',
      'Bridge workflow contracts only need one project.',
    );
  });

  test('forks a loaded thread through the ACP extension', async () => {
    const bridge = await startRealBridge({
      scenario: {
        chats: [
          {
            id: 'thread-layout',
            title: 'Fork source',
            messages: [
              { id: 'fork-user-1', role: 'user', text: 'Establish context.' },
              { id: 'fork-agent-1', role: 'assistant', text: 'Context established.' },
              { id: 'fork-user-2', role: 'user', text: 'Fork before this request.' },
              { id: 'fork-agent-2', role: 'assistant', text: 'This branch should be excluded.' },
            ],
          },
        ],
      },
    });
    try {
      const result = asRecord(
        await bridge.request('bridge/thread/fork', {
          submissionId: 'fork-submission',
          threadId: E2E_THREADS.layout,
          messageId: 'fork-user-2',
        }),
      );
      expect(result['submissionId']).toBe('fork-submission');
      const thread = asRecord(result['thread']);
      expect(thread['id']).not.toBe(E2E_THREADS.layout);
      expect(thread['name']).toBe('Forked layout session');
    } finally {
      await bridge.close();
    }
  });

  test('edits and steers a queued message while a turn is active', async () => {
    const bridge = await startRealBridge();
    try {
      await bridge.streamAssistantTurn({
        threadId: E2E_THREADS.layout,
        chunks: ['Holding the active turn.'],
        whileRunning: async () => {
          const sent = asRecord(
            await bridge.request('bridge/thread/queue/send', {
              threadId: E2E_THREADS.layout,
              submissionId: 'queue-submission',
              content: 'Original queued prompt',
              turnStart: turnStart('Original queued prompt'),
            }),
          );
          expect(sent['disposition']).toBe('queued');
          const queued = firstQueueItem(sent);
          expect(queued['content']).toBe('Original queued prompt');
          const itemId = requireString(queued['id'], 'queued item id');

          const editing = asRecord(
            await bridge.request('bridge/thread/queue/edit/start', {
              threadId: E2E_THREADS.layout,
              itemId,
            }),
          );
          expect(editing['ok']).toBe(true);

          const committed = asRecord(
            await bridge.request('bridge/thread/queue/edit/commit', {
              threadId: E2E_THREADS.layout,
              itemId,
              content: 'Edited queued prompt',
            }),
          );
          expect(firstQueueItem(committed)['content']).toBe('Edited queued prompt');

          await bridge.request('bridge/thread/queue/edit/start', {
            threadId: E2E_THREADS.layout,
            itemId,
          });
          const cancelled = asRecord(
            await bridge.request('bridge/thread/queue/edit/cancel', {
              threadId: E2E_THREADS.layout,
              itemId,
            }),
          );
          expect(cancelled['ok']).toBe(true);

          const steered = asRecord(
            await bridge.request('bridge/thread/queue/steer', {
              threadId: E2E_THREADS.layout,
              itemId,
            }),
          );
          expect(steered['ok']).toBe(true);
          expect(asRecord(steered['queue'])['items']).toEqual([]);
        },
      });
    } finally {
      await bridge.close();
    }
  });
});

function turnStart(content: string): Record<string, unknown> {
  return {
    threadId: E2E_THREADS.layout,
    input: [{ type: 'text', text: content, text_elements: [] }],
    approvalPolicy: 'untrusted',
  };
}

function firstQueueItem(response: Record<string, unknown>): Record<string, unknown> {
  const queue = asRecord(response['queue']);
  const items = queue['items'];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Expected the production bridge response to contain a queued item.');
  }
  return asRecord(items[0]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object, received ${JSON.stringify(value)}.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string.`);
  }
  return value;
}
