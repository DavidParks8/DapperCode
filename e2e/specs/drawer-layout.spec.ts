import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import {
  expectContainedWithin,
  expectLeftAligned,
  expectNoOverlap,
  expectRightAligned,
  expectStackedVertically,
  expectTouchTarget,
  expectVisible,
  expectWithinViewport,
} from '../layout/assertions.ts';
import { readRect, readRects } from '../layout/geometry.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

test.describe('navigation drawer layout', () => {
  test('every seeded session gets a row on a shared rail', async ({ app }) => {
    await app.openDrawer();
    const rows = selectors.drawerChatRows(app.page);
    await expect(rows).toHaveCount(3);

    await expectStackedVertically(rows);
    await expectLeftAligned(rows);
    await expectRightAligned(rows);
  });

  test('rows stay inside the drawer surface and inside the viewport', async ({ app }) => {
    await app.openDrawer();
    const drawer = selectors.drawer(app.page);
    await expectVisible(drawer);
    await expectWithinViewport(drawer);

    for (const chatId of [E2E_THREADS.layout, E2E_THREADS.short, E2E_THREADS.longTitle]) {
      await expectContainedWithin(selectors.drawerChatRow(app.page, chatId), drawer);
    }
  });

  test('a session title that overflows does not widen or grow its row', async ({ app }) => {
    await app.openDrawer();
    const longTitleRow = selectors.drawerChatRow(app.page, E2E_THREADS.longTitle);
    const shortTitleRow = selectors.drawerChatRow(app.page, E2E_THREADS.short);

    // `thread-long-title` is seeded with a title far wider than the drawer. Truncation is the
    // contract: the row must match its siblings in both width and height.
    const [longRect, shortRect] = await Promise.all([
      readRect(longTitleRow),
      readRect(shortTitleRow),
    ]);
    expect(Math.round(longRect.width)).toBe(Math.round(shortRect.width));
    expect(Math.round(longRect.height)).toBe(Math.round(shortRect.height));
    await expectContainedWithin(longTitleRow, selectors.drawer(app.page));
  });

  test('rows are comfortable touch targets and never overlap each other', async ({ app }) => {
    await app.openDrawer();
    const rows = selectors.drawerChatRows(app.page);
    const count = await rows.count();

    for (let index = 0; index < count; index += 1) {
      await expectTouchTarget(rows.nth(index), 44);
    }
    for (let index = 1; index < count; index += 1) {
      await expectNoOverlap(rows.nth(index - 1), rows.nth(index));
    }
  });

  test('drawer actions stay clear of the session list', async ({ app }) => {
    await app.openDrawer();
    const rows = await readRects(selectors.drawerChatRows(app.page));
    const settingsRect = await readRect(selectors.drawerSettings(app.page));

    // Settings anchors the bottom of the drawer; a regression that lets it float into the list is
    // invisible to functional tests but obvious to a user.
    for (const row of rows) {
      expect(settingsRect.top).toBeGreaterThanOrEqual(row.bottom - 1);
    }
    await expectTouchTarget(selectors.drawerSettings(app.page), 44);
  });

  test('the drawer overlays the chat rather than displacing it', async ({ app }) => {
    const composerBefore = await readRect(selectors.composer(app.page));
    await app.openDrawer();
    const composerAfter = await readRect(selectors.composer(app.page));

    expect(Math.round(composerAfter.top)).toBe(Math.round(composerBefore.top));
    expect(Math.round(composerAfter.width)).toBe(Math.round(composerBefore.width));
  });
});
