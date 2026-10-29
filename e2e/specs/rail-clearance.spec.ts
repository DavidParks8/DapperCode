import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import { readRect } from '../layout/geometry.ts';
import { expectShellMode, expectedShellModeFor } from '../layout/shell.ts';
import { scenarioThreadId } from '../harness/scenario.ts';

test('the pinned message rail stays clear of bubbles and the composer', async ({ createApp }) => {
  test.skip(
    expectedShellModeFor(test.info().project.name) !== 'pinned',
    'Only wide windows pin the message rail open.',
  );
  const app = await createApp({
    chatId: scenarioThreadId('rail-clearance'),
    scenario: {
      chats: [
        {
          id: 'rail-clearance',
          title: 'Rail clearance',
          messages: [
            {
              id: 'rail-user-1',
              role: 'user',
              text: 'Start a subagent to print a message so I can test the chat interface',
            },
            {
              id: 'rail-assistant-1',
              role: 'assistant',
              text: 'Subagent message: Hello from the subagent! The chat interface test is working, and this answer is long enough to fill the readable column.',
            },
            {
              id: 'rail-user-2',
              role: 'user',
              text: 'Check that the transcript and composer leave room for the rail on the right edge.',
            },
          ],
        },
      ],
    },
  });
  await expectShellMode(app.page, 'pinned');
  const bars = selectors.scrollRailBars(app.page);
  await expect(bars).toHaveCount(2);

  const [composer, submit, messageRects, barRects] = await Promise.all([
    readRect(selectors.composer(app.page)),
    readRect(selectors.composerSubmitSlot(app.page)),
    selectors.messages(app.page).evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    ),
    bars.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    ),
  ]);
  const railLeft = Math.min(...barRects.map((rect) => rect.left));

  expect(messageRects.length).toBeGreaterThan(0);
  for (const message of messageRects) {
    expect(railLeft - message.right).toBeGreaterThanOrEqual(8);
  }
  for (const bar of barRects) {
    expect(bar.bottom).toBeLessThanOrEqual(composer.top);
    expect(bar.bottom <= submit.top || bar.left >= submit.right).toBe(true);
  }
});
