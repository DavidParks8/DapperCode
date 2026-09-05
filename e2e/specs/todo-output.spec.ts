import { expect } from '@playwright/test';

import { selectors } from '../fixtures/selectors.ts';
import { test, type AppHandle } from '../fixtures/test.ts';
import { E2E_THREADS } from '../harness/scenario.ts';
import {
  expectContainedWithin,
  expectNoOverlap,
  expectStackedVertically,
  expectWithinViewport,
} from '../layout/assertions.ts';

const todos = [
  { content: 'Inspect the todo tool response', status: 'completed', priority: 'high' },
  {
    content:
      'Render the expanded tool output as readable tasks with status labels that wrap on a narrow mobile screen',
    status: 'in_progress',
    priority: 'medium',
  },
  { content: 'Verify the final mobile layout', status: 'pending', priority: 'low' },
];

test('expands todo output as a list after live completion and history reload', async ({
  createApp,
}, testInfo) => {
  const app = await createApp({ chatId: E2E_THREADS.short });
  await app.bridge.streamAssistantTurn({
    threadId: E2E_THREADS.short,
    chunks: [],
    toolSteps: [
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'todo-output',
          title: 'todowrite',
          kind: 'other',
          status: 'in_progress',
        },
        whilePaused: async () => {
          await expect(selectors.toolHeader(app.page)).toHaveCount(1);
          await expect(selectors.toolTodoList(app.page)).toHaveCount(0);
        },
      },
      {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'todo-output',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: JSON.stringify(todos, null, 2) } },
          ],
        },
      },
    ],
  });

  await expect(selectors.composerStopSlot(app.page)).toHaveCount(0);
  await expectExpandedTodos(app);
  await app.page.screenshot({ path: testInfo.outputPath('todo-output-expanded.png') });
  await selectors.toolTitleToggle(app.page).click();
  await expect(selectors.toolTodoList(app.page)).toHaveCount(0);
  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expectExpandedTodos(app);
});

async function expectExpandedTodos(app: AppHandle): Promise<void> {
  await expect(selectors.toolOutput(app.page)).toHaveCount(0);
  await selectors.toolTitleToggle(app.page).click();
  const list = selectors.toolTodoList(app.page);
  const rows = selectors.toolTodoItems(app.page);
  await expect(list).toBeVisible();
  await expect(rows).toHaveCount(todos.length);
  await expect(selectors.toolTodoText(app.page)).toHaveText(todos.map((todo) => todo.content));
  await expect(rows.nth(0)).toHaveAccessibleName(
    'Inspect the todo tool response. Completed. high priority',
  );
  await expect(rows.nth(1)).toHaveAccessibleName(/In progress\. medium priority$/);
  await expect(rows.nth(2)).toHaveAccessibleName(/Pending\. low priority$/);
  await expect(selectors.toolTextOutput(app.page)).toHaveCount(0);
  await expectStackedVertically(rows);
  await expectWithinViewport(list);
  await expectNoOverlap(list, selectors.composer(app.page));
  for (let index = 0; index < todos.length; index += 1) {
    await expectContainedWithin(selectors.toolTodoText(rows.nth(index)), rows.nth(index));
    await expectContainedWithin(rows.nth(index), list);
  }
}
