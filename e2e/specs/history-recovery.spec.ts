import type { Page } from '@playwright/test';
import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { E2E_THREADS, FIXED_NOW_MS, scenarioThreadId } from '../harness/scenario.ts';

const kickoff = 'Complete this task while the phone is locked.';
const finalAnswer = 'The locked-phone task finished successfully.';
const otherThread = scenarioThreadId('other-history-chat');

test('incomplete history survives foreground and chat navigation, then recovers automatically', async ({
  createApp,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  let fault: 'none' | 'empty' | 'error' = 'none';
  let emptyReads = 0;
  let failedReads = 0;
  let opened = 0;
  let closed = 0;
  let lastEventId = 0;
  let answerDeliveredInSnapshot = false;

  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/rpc') return;
    opened += 1;
    socket.on('close', () => (closed += 1));
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (typeof frame.eventId === 'number') lastEventId = Math.max(lastEventId, frame.eventId);
    });
  });
  await page.routeWebSocket('**/rpc*', (route) => {
    const server = route.connectToServer();
    const reads = new Set<string | number>();
    route.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.method === 'thread/read' && frame.params?.threadId === E2E_THREADS.layout) {
        reads.add(frame.id);
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (reads.delete(frame.id) && frame.result?.thread?.acpSnapshot) {
        if (fault === 'error') {
          failedReads += 1;
          route.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32000, message: 'History reconstruction is temporarily unavailable' },
            }),
          );
          return;
        }
        if (fault === 'empty') {
          emptyReads += 1;
          const thread = frame.result.thread;
          thread.name = null;
          thread.preview = null;
          thread.acpSnapshot.session.title = null;
          thread.acpSnapshot.messages = [];
          thread.acpSnapshot.timeline = [];
          thread.acpSnapshot.tools = [];
          for (const collection of ['messageCollection', 'reasoningCollection', 'toolCollection']) {
            thread.acpSnapshot[collection] = { truncated: false, omittedCount: 0, revision: 0 };
          }
          route.send(JSON.stringify(frame));
          return;
        }
        answerDeliveredInSnapshot ||= JSON.stringify(
          frame.result.thread.acpSnapshot.messages,
        ).includes(finalAnswer);
      }
      route.send(raw);
    });
  });

  await page.clock.setSystemTime(FIXED_NOW_MS);
  const app = await createApp({
    chatId: E2E_THREADS.layout,
    scenario: {
      chats: [
        { id: 'thread-layout', title: 'Locked task', messages: [] },
        { id: 'other-history-chat', title: 'Other chat', messages: [] },
      ],
    },
  });
  const route = page.url();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const turn = await app.bridge.prepareAssistantTurn({
    messageId: 'offline-history-answer',
    chunks: [...Array.from({ length: 2_100 }, () => '.'), finalAnswer],
  });
  await selectors.composerInput(page).fill(kickoff);
  await selectors.composerSend(page).click();
  await turn.waitForStart();
  await expect(selectors.userMessages(page)).toContainText(kickoff);
  await expect(selectors.composerStopSlot(page)).toBeVisible();
  const title = 'Locked task transcript';
  await expect(selectors.transcriptScroll(page)).toHaveAttribute('aria-label', title);

  await test.step('background completion with unavailable history', async () => {
    await visibility(page, 'hidden');
    await expect.poll(() => opened - closed).toBe(0);
    const cursor = lastEventId;
    await page.clock.setSystemTime(FIXED_NOW_MS + 25 * 60_000);
    await turn.release();
    await expect
      .poll(
        async () => {
          const response = (await app.bridge.request('thread/read', {
            threadId: E2E_THREADS.layout,
          })) as {
            thread: { acpSnapshot: { active: { runId?: string }; messages: unknown[] } };
          };
          return (
            !response.thread.acpSnapshot.active.runId &&
            JSON.stringify(response.thread.acpSnapshot.messages).includes(finalAnswer)
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const replay = (await app.bridge.request('bridge/events/replay', {
      afterEventId: cursor,
      limit: 1,
    })) as {
      earliestEventId: number;
    };
    expect(replay.earliestEventId).toBeGreaterThan(cursor + 1);
    fault = 'empty';
    await visibility(page, 'visible');
    await expect.poll(() => emptyReads).toBeGreaterThan(0);
    await expect(selectors.historyRecovery(page)).toBeVisible();
    await expect(selectors.userMessages(page)).toContainText(kickoff);
    await settled(page);
    expect(answerDeliveredInSnapshot).toBe(false);
  });

  await test.step('navigate away and back without losing the cached prompt or title', async () => {
    await app.openDrawer();
    await selectors.drawerChatRow(page, otherThread).click();
    await expect(selectors.transcriptScroll(page)).toHaveAttribute(
      'aria-label',
      'Other chat transcript',
    );
    await app.openDrawer();
    await selectors.drawerChatRow(page, E2E_THREADS.layout).click();
    await expect(selectors.transcriptScroll(page)).toHaveAttribute('aria-label', title);
    await expect(selectors.userMessages(page)).toContainText(kickoff);
    await expect(selectors.historyRecovery(page)).toBeVisible();
    await settled(page);
    await selectors.historyRecovery(page).click({ trial: true });
    if ((await page.getByLabel('Open navigation drawer').count()) > 0) {
      await expect
        .poll(async () => {
          const bounds = await selectors.drawer(page).boundingBox();
          return !bounds || bounds.x + bounds.width <= 1;
        })
        .toBe(true);
    }
    const screenshot = testInfo.outputPath('recoverable-history-error.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('recoverable-history-error', {
      path: screenshot,
      contentType: 'image/png',
    });
  });

  await test.step('manual retry reports failure, automatic retry restores the answer', async () => {
    fault = 'error';
    await selectors.historyRecovery(page).click();
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(selectors.userMessages(page)).toContainText(kickoff);
    await expect(selectors.transcriptScroll(page)).toHaveAttribute('aria-label', title);
    await expect(selectors.historyRecovery(page)).toBeVisible();
    await settled(page);
    fault = 'none';
    await expect(selectors.assistantMessages(page).filter({ hasText: finalAnswer })).toHaveCount(
      1,
      { timeout: 20_000 },
    );
    expect(answerDeliveredInSnapshot).toBe(true);
    await expect(selectors.historyRecovery(page)).toHaveCount(0);
    await expect(selectors.userMessages(page)).toContainText(kickoff);
    await settled(page);
  });

  await test.step('follow-up turn and a second reconnect remain usable', async () => {
    const followup = await app.bridge.prepareAssistantTurn({
      messageId: 'history-followup',
      chunks: ['The recovered chat is still usable.'],
    });
    await selectors.composerInput(page).fill('Continue after history recovery.');
    await selectors.composerSend(page).click();
    await followup.waitForStart();
    await followup.release();
    await expect(
      selectors.assistantMessages(page).filter({ hasText: 'The recovered chat is still usable.' }),
    ).toHaveCount(1);
    await visibility(page, 'hidden');
    await expect.poll(() => opened - closed).toBe(0);
    await visibility(page, 'visible');
    await expect.poll(() => opened - closed).toBe(1);
    await expect(selectors.userMessages(page)).toContainText([
      'Continue after history recovery.',
      kickoff,
    ]);
    await expect(selectors.assistantMessages(page).filter({ hasText: finalAnswer })).toHaveCount(1);
    await expect(selectors.historyRecovery(page)).toHaveCount(0);
    await settled(page);
    expect(page.url()).toBe(route);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  });
});

async function visibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function settled(page: Page) {
  await expect(selectors.composerStopSlot(page)).toHaveCount(0);
  await expect(selectors.runningGlyph(page)).toHaveCount(0);
  await expect(selectors.composerSubmitSlot(page)).toBeVisible();
  await expect(selectors.composerInput(page)).toBeEditable();
}
