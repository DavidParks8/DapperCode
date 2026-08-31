import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import { expectNoOverlap, expectVisible, expectWithinViewport } from '../layout/assertions.ts';
import { readRect } from '../layout/geometry.ts';
import {
  expectShellMode,
  expectedShellModeFor,
  TABLET_LAYOUT_MIN_WIDTH,
  TABLET_SIDEBAR_WIDTH,
} from '../layout/shell.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

/**
 * The app switches between two shells at `TABLET_LAYOUT_MIN_WIDTH`. Both branches are exercised
 * here: the suite's `phone` project lands on the overlay shell and `tablet` on the pinned one, and
 * each test asserts the branch that actually applies to the viewport it is running in.
 */
test.describe('shell layout', () => {
  test('the shell matches the viewport width', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    // Asserted against the project's declared shell, so a moved breakpoint fails here rather than
    // quietly rerouting the test to the other branch.
    const shell = await expectShellMode(app.page, expectedShellModeFor(test.info().project.name));
    const opener = app.page.getByLabel('Open navigation drawer');

    if (shell.mode === 'pinned') {
      // Docked: no toggle exists, because the drawer can never be dismissed.
      await expect(opener).toHaveCount(0);
      await expectVisible(selectors.drawer(app.page));
    } else {
      await expect(opener).toHaveCount(1);
      // Closed overlay drawers park off-screen rather than collapsing to zero width.
      expect(shell.drawer.right).toBeLessThanOrEqual(shell.viewport.left + 1);
    }
  });

  test('a docked drawer and the chat pane tile the viewport', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    test.skip(
      expectedShellModeFor(test.info().project.name) !== 'pinned',
      'Only the wide shell docks the drawer.',
    );
    const shell = await expectShellMode(app.page, 'pinned');

    expect(Math.round(shell.drawer.left)).toBe(Math.round(shell.viewport.left));
    expect(Math.round(shell.drawer.height)).toBe(Math.round(shell.viewport.height));
    expect(shell.drawer.width).toBeLessThanOrEqual(TABLET_SIDEBAR_WIDTH);

    // Side by side with no gap and no overlap. A 1px allowance covers the hairline divider drawn
    // between the sidebar and the pane.
    expect(shell.pane.left).toBeGreaterThanOrEqual(shell.drawer.right);
    expect(shell.pane.left - shell.drawer.right).toBeLessThanOrEqual(1);
    expect(
      Math.abs(shell.drawer.width + shell.pane.width - shell.viewport.width),
    ).toBeLessThanOrEqual(1);
    expect(Math.round(shell.pane.right)).toBe(Math.round(shell.viewport.right));

    await expectNoOverlap(selectors.drawer(app.page), selectors.transcript(app.page));
    await expectNoOverlap(selectors.drawer(app.page), selectors.composer(app.page));
    await expectWithinViewport(selectors.drawer(app.page));
  });

  test('an overlay drawer covers the chat instead of tiling with it', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    test.skip(
      expectedShellModeFor(test.info().project.name) !== 'overlay',
      'Only the narrow shell overlays the drawer.',
    );
    const shell = await expectShellMode(app.page, 'overlay');

    expect(Math.round(shell.pane.left)).toBe(Math.round(shell.viewport.left));
    expect(Math.round(shell.pane.width)).toBe(Math.round(shell.viewport.width));

    await app.openDrawer();
    const openDrawerRect = await readRect(selectors.drawer(app.page));
    const transcriptRect = await readRect(selectors.transcript(app.page));

    expect(Math.round(openDrawerRect.left)).toBe(Math.round(shell.viewport.left));
    expect(Math.round(transcriptRect.left)).toBe(Math.round(shell.viewport.left));
    expect(openDrawerRect.right).toBeGreaterThan(transcriptRect.left);
  });

  test('the session list is reachable in both shells', async ({ app }) => {
    await app.openDrawer();
    const rows = selectors.drawerChatRows(app.page);
    await expect(rows).toHaveCount(3);
  });

  /**
   * The two fixed viewports sit comfortably either side of the breakpoint, so neither would notice
   * it drifting by a few pixels. This pins the transition itself: one pixel below the breakpoint
   * must still overlay, and exactly at it must dock. It runs once rather than per project, because
   * it sets its own viewport.
   */
  test('the shell switches exactly at the tablet breakpoint', async ({ createApp }) => {
    test.skip(
      expectedShellModeFor(test.info().project.name) !== 'overlay',
      'The breakpoint itself only needs checking once.',
    );
    const app = await createApp({ chatId: E2E_THREADS.layout });

    await app.page.setViewportSize({ width: TABLET_LAYOUT_MIN_WIDTH - 1, height: 900 });
    await app.settle();
    await expectShellMode(app.page, 'overlay');

    await app.page.setViewportSize({ width: TABLET_LAYOUT_MIN_WIDTH, height: 900 });
    await app.settle();
    await expectShellMode(app.page, 'pinned');
  });
});
