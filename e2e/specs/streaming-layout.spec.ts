import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import {
  expectContainedWithin,
  expectNoOverlap,
  expectRowOrder,
  expectStableDuring,
  expectTouchTarget,
  expectVisible,
  expectWithinViewport,
} from '../layout/assertions.ts';
import { readRect } from '../layout/geometry.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

/**
 * A streaming turn is when the chat layout is most likely to break: text arrives in deltas, the
 * transcript grows, and the composer action changes from send to stop. These specs assert that the
 * furniture around the transcript holds still while its contents change.
 */
test.describe('streaming layout', () => {
  test('the composer stays anchored for the whole of a streaming turn', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const composer = selectors.composer(app.page);

    // Sampled continuously, so a composer that jumps mid-stream and settles back still fails.
    await expectStableDuring(composer, async () => {
      await app.bridge.streamAssistantTurn({
        threadId: E2E_THREADS.layout,
        chunks: [
          'Streaming the first sentence of a long reply. ',
          'Adding a second sentence so the transcript has to grow. ',
          'And a third that is long enough to wrap across several lines of the message body.',
        ],
        delayMs: 120,
      });
    });

    await expectWithinViewport(composer);
    await expectNoOverlap(selectors.transcript(app.page), composer);
  });

  test('the stop control replaces send without moving its slot', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const controls = selectors.composerControls(app.page);
    const submit = selectors.composerSubmitSlot(app.page);
    const input = selectors.composerInputSurface(app.page);

    const [controlsIdle, submitIdle, inputIdle] = await Promise.all([
      readRect(controls),
      readRect(submit),
      readRect(input),
    ]);

    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.layout,
      chunks: ['Working on it. ', 'Still working. ', 'Done.'],
      delayMs: 20,
      // The turn is held open for the duration of these measurements, so a loaded machine cannot
      // finish the run out from under them.
      whileRunning: async () => {
        const stop = selectors.composerStopSlot(app.page);
        await expectVisible(stop);
        await expect(submit).toHaveCount(0);

        const [controlsRunning, inputRunning, stopRect] = await Promise.all([
          readRect(controls),
          readRect(input),
          readRect(stop),
        ]);

        // Send and stop are two states of one action slot. Switching state must not resize the
        // input, move the action, or grow the composer.
        expect(Math.round(controlsRunning.width)).toBe(Math.round(controlsIdle.width));
        expect(Math.round(controlsRunning.height)).toBe(Math.round(controlsIdle.height));
        expect(Math.round(inputRunning.left)).toBe(Math.round(inputIdle.left));
        expect(Math.round(inputRunning.width)).toBe(Math.round(inputIdle.width));
        expect(Math.round(inputRunning.height)).toBe(Math.round(inputIdle.height));

        expect(Math.round(stopRect.left)).toBe(Math.round(submitIdle.left));
        expect(Math.round(stopRect.right)).toBe(Math.round(submitIdle.right));
        expect(Math.round(stopRect.width)).toBe(Math.round(submitIdle.width));
        expect(Math.round(stopRect.height)).toBe(Math.round(submitIdle.height));
        await expectTouchTarget(stop);
        await expectRowOrder([input, stop]);
        await expectNoOverlap(input, stop);
        await expectContainedWithin(stop, controls);
      },
    });
  });

  test('the composer returns to its resting shape once the turn finishes', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const controls = selectors.composerControls(app.page);
    const input = selectors.composerInputSurface(app.page);
    const [controlsIdle, inputIdle] = await Promise.all([readRect(controls), readRect(input)]);

    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.layout,
      chunks: ['A short reply.'],
      delayMs: 30,
    });

    await expect(selectors.composerStopSlot(app.page)).toHaveCount(0);
    const [controlsAfter, inputAfter] = await Promise.all([readRect(controls), readRect(input)]);
    expect(Math.round(controlsAfter.width)).toBe(Math.round(controlsIdle.width));
    expect(Math.round(controlsAfter.height)).toBe(Math.round(controlsIdle.height));
    expect(Math.round(inputAfter.width)).toBe(Math.round(inputIdle.width));
  });

  test('the streamed answer lands on the transcript rail and stays clear of the composer', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const existingAssistant = await readRect(
      selectors
        .assistantMessages(app.page)
        .filter({ hasText: 'The transcript uses a fixed bottom inset' }),
    );

    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.layout,
      messageId: 'msg-streamed',
      chunks: ['A streamed reply that should sit on the same rail as every other message.'],
      delayMs: 30,
    });

    const streamed = selectors
      .assistantMessages(app.page)
      .filter({ hasText: 'A streamed reply that should sit on the same rail' });
    await expectVisible(streamed);
    const streamedRect = await readRect(streamed);

    expect(Math.round(streamedRect.left)).toBe(Math.round(existingAssistant.left));
    expect(Math.round(streamedRect.width)).toBe(Math.round(existingAssistant.width));
    await expectNoOverlap(streamed, selectors.composer(app.page));
    await expectContainedWithin(streamed, selectors.transcript(app.page));
  });

  test('a failed run leaves the composer usable and correctly sized', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const controls = selectors.composerControls(app.page);
    const before = await readRect(controls);

    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.layout,
      chunks: ['Partial answer before the failure.'],
      delayMs: 30,
      succeed: false,
    });

    // Error handling frequently forgets to restore the composer, stranding the user with a stop
    // button and no way to send.
    await expectVisible(selectors.composerSubmitSlot(app.page));
    await expect(selectors.composerStopSlot(app.page)).toHaveCount(0);
    const after = await readRect(controls);
    expect(Math.round(after.height)).toBe(Math.round(before.height));
    expect(Math.round(after.width)).toBe(Math.round(before.width));
    await expectWithinViewport(selectors.composer(app.page));
    await expectNoOverlap(selectors.transcript(app.page), selectors.composer(app.page));
  });
});
