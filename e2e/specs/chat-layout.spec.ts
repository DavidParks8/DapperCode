import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import {
  expectContainedWithin,
  expectHorizontalGap,
  expectLeftAligned,
  expectNoOverlap,
  expectRightAligned,
  expectStackedVertically,
  expectSymmetricHorizontalInsets,
  expectTouchTarget,
  expectVerticalGap,
  expectVisible,
  expectWithinViewport,
} from '../layout/assertions.ts';
import { readRect, readViewportRect } from '../layout/geometry.ts';
import { expect } from '@playwright/test';

test.describe('chat screen layout', () => {
  test('the composer is anchored to the bottom without covering the transcript', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const transcript = selectors.transcript(app.page);
    const composer = selectors.composer(app.page);

    await expectVisible(transcript);
    await expectVisible(composer);

    // The composer must own the space below the transcript rather than floating over it, which is
    // the regression that hides the newest message behind the input.
    await expectStackedVertically([transcript, composer]);
    await expectNoOverlap(transcript, composer);
    await expectVerticalGap(transcript, composer, 0);
    await expectWithinViewport(composer);

    // Width and left edge are compared against the chat pane, not the viewport: on a wide screen
    // the docked drawer legitimately takes the leading part of the window.
    const viewport = await readViewportRect(app.page);
    const [composerRect, transcriptRect] = await Promise.all([
      readRect(composer),
      readRect(transcript),
    ]);
    expect(Math.round(composerRect.bottom)).toBe(Math.round(viewport.bottom));
    expect(Math.round(composerRect.width)).toBe(Math.round(transcriptRect.width));
    expect(Math.round(composerRect.left)).toBe(Math.round(transcriptRect.left));
  });

  test('the composer controls keep symmetric insets and a single row', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const controls = selectors.composerControls(app.page);
    const inputSurface = selectors.composerInputSurface(app.page);
    const submit = selectors.composerSubmitSlot(app.page);

    await expectVisible(controls);
    await expectSymmetricHorizontalInsets(controls, selectors.composer(app.page));

    // The input and the send button share one row: they must not collide, and the button must stay
    // inside the control group rather than spilling past the trailing inset.
    await expectNoOverlap(inputSurface, submit);
    await expectHorizontalGap(inputSurface, submit, 8);
    await expectContainedWithin(inputSurface, controls);
    await expectContainedWithin(submit, controls);
    await expectRightAligned([controls, submit]);
  });

  test('the send control is a comfortable touch target', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    await expectTouchTarget(selectors.composerSubmitSlot(app.page));
  });

  test('transcript messages share a rail and stack in chronological order', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const userMessage = selectors.message(app.page, 'user', 'msg-user-1');
    const assistantMessage = selectors.message(app.page, 'assistant', 'msg-assistant-1');

    await expectVisible(userMessage);
    await expectVisible(assistantMessage);

    // The list renders inverted, so this also guards against the rows being painted in reverse.
    await expectStackedVertically([userMessage, assistantMessage]);
    await expectLeftAligned([userMessage, assistantMessage]);
    await expectRightAligned([userMessage, assistantMessage]);
  });

  test('messages clear the top chrome and never slide under the composer', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const topChrome = selectors.topChrome(app.page);
    const composer = selectors.composer(app.page);
    const messages = selectors.messages(app.page);

    await expect(messages).toHaveCount(2);
    const first = messages.first();
    const last = messages.last();

    await expectNoOverlap(topChrome, first);
    await expectNoOverlap(composer, first);
    await expectNoOverlap(composer, last);
    await expectContainedWithin(first, selectors.transcript(app.page));
    await expectContainedWithin(last, selectors.transcript(app.page));
  });

  test('the header rows stay inside the top chrome', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const topChrome = selectors.topChrome(app.page);

    await expectContainedWithin(selectors.chatHeaderRow(app.page), topChrome);
    await expectContainedWithin(selectors.sessionMetaRow(app.page), topChrome);
    await expectWithinViewport(topChrome);
  });

  test('a long assistant answer wraps instead of widening the rail', async ({ createApp }) => {
    const app = await createApp({ chatId: 'thread-layout' });
    const assistantMessage = selectors.message(app.page, 'assistant', 'msg-assistant-1');
    const transcript = selectors.transcript(app.page);

    // The seeded answer is deliberately long: it must gain height, not width.
    const [messageRect, transcriptRect] = await Promise.all([
      readRect(assistantMessage),
      readRect(transcript),
    ]);
    expect(messageRect.width).toBeLessThanOrEqual(transcriptRect.width);
    expect(messageRect.height).toBeGreaterThan(messageRect.width * 0.25);
    await expectContainedWithin(assistantMessage, transcript);
  });
});
