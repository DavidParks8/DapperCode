import { test, expect } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import { scenarioThreadId } from '../harness/scenario.ts';

test('slow scrolling keeps row spacing stable as virtualized cells mount', async ({
  createApp,
}, testInfo) => {
  const app = await createApp({
    chatId: scenarioThreadId('scroll-history'),
    scenario: {
      chats: [
        {
          id: 'scroll-history',
          title: 'Scroll history',
          messages: Array.from({ length: 120 }, (_, index) => ({
            id: `scroll-${String(index)}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
            text:
              index % 2 === 0
                ? `Inspect file ${String(index)}`
                : `File ${String(index)} is ready. The transcript must keep its position while older rows enter the render window.`,
          })),
        },
      ],
    },
  });
  const scroll = selectors.transcriptScroll(app.page);
  const items = selectors.transcriptItems(app.page);
  await expect(items.first()).toBeVisible();
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(2_000);

  // Cell length must include spacing, including cells not yet mounted. A parent gap is absent
  // from FlatList's measurements and changes the scroll range as it replaces its spacers.
  await expect
    .poll(() =>
      items.first().evaluate((item) => {
        const cell = item.parentElement;
        if (!cell) {
          throw new Error('Expected a virtualized cell');
        }
        return cell.getBoundingClientRect().height - item.getBoundingClientRect().height;
      }),
    )
    .toBe(20);

  // RN Web does not emit native drag callbacks for wheel/programmatic scrolling. The real rail
  // gesture enters history-browsing mode first, so auto-follow cannot pull new cells back to zero.
  const rail = await selectors.scrollRailBars(app.page).last().boundingBox();
  if (!rail) {
    throw new Error('Expected the history scroll rail');
  }
  await app.page.mouse.move(rail.x + rail.width - 2, rail.y + rail.height / 2);
  await app.page.mouse.down();
  try {
    await app.page.waitForTimeout(250);
    await app.page.mouse.move(rail.x + rail.width - 2, rail.y - 12, { steps: 3 });
    await expect(selectors.jumpToLatest(app.page)).toBeVisible();
  } finally {
    await app.page.mouse.up();
  }
  const initiallyMounted = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  for (let step = 0; step < 35; step += 1) {
    await scroll.evaluate((element) => {
      element.scrollTop += 80;
    });
    await app.page.waitForTimeout(80);
  }
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(2_000);
  await expect(
    selectors.assistantMessages(app.page).filter({ hasText: 'File 119 is ready.' }),
  ).not.toBeInViewport();
  await expect
    .poll(() =>
      items.evaluateAll(
        (nodes, initial) =>
          nodes.some((node) => !initial.includes(node.getAttribute('data-testid'))),
        initiallyMounted,
      ),
    )
    .toBe(true);
  const gaps = await items.evaluateAll((nodes) =>
    nodes.slice(0, -1).map((item) => {
      const cell = item.parentElement;
      if (!cell) {
        throw new Error('Expected a virtualized cell');
      }
      return cell.getBoundingClientRect().height - item.getBoundingClientRect().height;
    }),
  );
  expect(gaps.every((gap) => Math.abs(gap - 20) <= 1)).toBe(true);
  await expect(selectors.composerInput(app.page)).toBeEnabled();
  await expect(selectors.composerStopSlot(app.page)).toHaveCount(0);
  await app.page.screenshot({ path: testInfo.outputPath('slow-scroll-settled.png') });
});
