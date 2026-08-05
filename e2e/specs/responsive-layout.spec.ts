import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import {
  expectContainedWithin,
  expectNoOverlap,
  expectSymmetricHorizontalInsets,
  expectVerticalGap,
  expectWithinViewport,
} from '../layout/assertions.ts';
import { readRect, readViewportRect } from '../layout/geometry.ts';
import { readShell } from '../layout/shell.ts';

/**
 * These assertions are written against the viewport rather than against fixed pixel values, so the
 * same spec is meaningful at every size. The suite runs it once per project (`phone`, `tablet`),
 * which is what turns it into a responsive check.
 */
test.describe('responsive layout', () => {
  test('the chat surface partitions the viewport with no gap and no overlap', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const shell = await readShell(app.page);
    const transcript = selectors.transcript(app.page);
    const composer = selectors.composer(app.page);

    const [transcriptRect, composerRect] = await Promise.all([
      readRect(transcript),
      readRect(composer),
    ]);

    // The chat pane is the unit of comparison: it is the whole viewport on a phone and the region
    // beside the docked drawer on a tablet.
    expect(Math.round(transcriptRect.width)).toBe(Math.round(shell.pane.width));
    expect(Math.round(composerRect.width)).toBe(Math.round(shell.pane.width));
    expect(Math.round(transcriptRect.left)).toBe(Math.round(shell.pane.left));
    expect(Math.round(composerRect.left)).toBe(Math.round(shell.pane.left));
    expect(Math.round(transcriptRect.top)).toBe(Math.round(shell.viewport.top));
    expect(Math.round(composerRect.bottom)).toBe(Math.round(shell.viewport.bottom));
    expect(Math.round(transcriptRect.height + composerRect.height)).toBe(
      Math.round(shell.viewport.height),
    );

    await expectVerticalGap(transcript, composer, 0);
    await expectNoOverlap(transcript, composer);
  });

  test('the top chrome spans the chat pane and stays at the top', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const viewport = await readViewportRect(app.page);
    const [chromeRect, transcriptRect] = await Promise.all([
      readRect(selectors.topChrome(app.page)),
      readRect(selectors.transcript(app.page)),
    ]);

    expect(Math.round(chromeRect.width)).toBe(Math.round(transcriptRect.width));
    expect(Math.round(chromeRect.left)).toBe(Math.round(transcriptRect.left));
    expect(Math.round(chromeRect.top)).toBe(Math.round(viewport.top));
    expect(chromeRect.height).toBeLessThan(viewport.height * 0.25);
  });

  test('the message rail keeps symmetric insets at every size', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const transcript = selectors.transcript(app.page);

    await expectSymmetricHorizontalInsets(
      selectors.message(app.page, 'user', 'msg-user-1'),
      transcript,
    );
    await expectSymmetricHorizontalInsets(
      selectors.message(app.page, 'assistant', 'msg-assistant-1'),
      transcript,
    );
  });

  test('the composer controls keep symmetric insets at every size', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    await expectSymmetricHorizontalInsets(
      selectors.composerControls(app.page),
      selectors.composer(app.page),
    );
  });

  test('the drawer never exceeds the viewport it opens over', async ({ app }) => {
    await app.openDrawer();
    const viewport = await readViewportRect(app.page);
    const drawerRect = await readRect(selectors.drawer(app.page));

    expect(drawerRect.width).toBeLessThanOrEqual(viewport.width);
    expect(drawerRect.height).toBeLessThanOrEqual(viewport.height + 1);
    await expectWithinViewport(selectors.drawer(app.page));

    for (const chatId of ['thread-layout', 'thread-short', 'thread-long-title']) {
      await expectContainedWithin(
        selectors.drawerChatRow(app.page, chatId),
        selectors.drawer(app.page),
      );
    }
  });
});
