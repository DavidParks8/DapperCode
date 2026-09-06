import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

test('a quick background return retains the live socket and a longer absence disconnects after ten seconds', async ({
  createApp,
  page,
}) => {
  test.setTimeout(90_000);
  let opened = 0;
  let closed = 0;
  let closedAt = 0;
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/rpc') return;
    opened += 1;
    socket.on('close', () => {
      closed += 1;
      closedAt = Date.now();
    });
  });
  const app = await createApp({
    chatId: E2E_THREADS.layout,
    scenario: { chats: [{ id: 'thread-layout', title: 'Quick unlock', messages: [] }] },
  });
  const turn = await app.bridge.prepareAssistantTurn({
    messageId: 'quick-unlock-answer',
    chunks: ['Work continued across the quick unlock.'],
  });
  await selectors.composerInput(page).fill('Keep working while I briefly lock the phone.');
  await selectors.composerSend(page).click();
  await turn.waitForStart();
  await expect(selectors.composerStopSlot(page)).toBeVisible();
  await expect(selectors.runningGlyph(page)).toBeVisible();
  const connectionsBeforeLock = opened;
  const route = page.url();

  const visibility = async (state: 'hidden' | 'visible') => {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  };

  await test.step('quick return cancels the disconnect without interrupting the running turn', async () => {
    await visibility('hidden');
    // Real elapsed time is the input: return before the grace period expires.
    await page.waitForTimeout(5_000);
    expect(closed).toBe(0);
    await visibility('visible');
    await page.waitForTimeout(6_000);
    expect(opened).toBe(connectionsBeforeLock);
    expect(closed).toBe(0);
    await expect(selectors.composerStopSlot(page)).toBeVisible();
    await expect(selectors.runningGlyph(page)).toBeVisible();
    await expect(selectors.historyRecovery(page)).toHaveCount(0);
    await expect(selectors.activityError(page)).toHaveCount(0);
  });

  await test.step('the original turn completes on the retained connection', async () => {
    await turn.release();
    await expect(
      selectors
        .assistantMessages(page)
        .filter({ hasText: 'Work continued across the quick unlock.' }),
    ).toHaveCount(1);
    await expect(selectors.composerStopSlot(page)).toHaveCount(0);
    await expect(selectors.runningGlyph(page)).toHaveCount(0);
    await expect(selectors.composerSubmitSlot(page)).toBeVisible();
    await expect(selectors.composerInput(page)).toBeEditable();
  });

  await test.step('a second, longer lock gets a fresh ten-second grace and then reconnects', async () => {
    const backgroundedAt = Date.now();
    await visibility('hidden');
    await expect.poll(() => closed, { timeout: 15_000 }).toBe(connectionsBeforeLock);
    expect(closedAt - backgroundedAt).toBeGreaterThanOrEqual(10_000);
    await visibility('visible');
    await expect.poll(() => opened - closed).toBe(1);
    await expect(selectors.historyRecovery(page)).toHaveCount(0);
    await expect(selectors.activityError(page)).toHaveCount(0);
    await expect(selectors.composerStopSlot(page)).toHaveCount(0);
    await expect(selectors.runningGlyph(page)).toHaveCount(0);
    await expect(selectors.composerInput(page)).toBeEditable();
    await expect(
      selectors
        .assistantMessages(page)
        .filter({ hasText: 'Work continued across the quick unlock.' }),
    ).toHaveCount(1);
    expect(page.url()).toBe(route);
  });
});
