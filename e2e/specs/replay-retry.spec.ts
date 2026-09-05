import type { WebSocketRoute } from '@playwright/test';

import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

interface Frame {
  id?: string | number;
  method?: string;
  eventId?: number;
  params?: {
    afterEventId?: number;
    event?: { type?: string };
  };
  result?: { events?: Frame[] };
}

test('replay retries a transient RPC error without new live traffic', async ({
  createApp,
  page,
}) => {
  test.setTimeout(90_000);
  const replayRequests: Frame[] = [];
  const heldNotifications: Array<{ frame: Frame; raw: string; route: WebSocketRoute }> = [];
  let holdNotifications = false;
  let armGap = false;
  let rejectedReplay = false;
  let recoveredTerminal = false;
  let deliveredLiveEventsAfterGap = 0;

  // Keep real authentication and transport. Only the first replay response is fault-injected.
  await page.routeWebSocket('**/rpc*', (route) => {
    const server = route.connectToServer();
    const replayIds = new Set<string | number>();
    route.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.method === 'bridge/events/replay' && frame.id !== undefined) {
        replayIds.add(frame.id);
        replayRequests.push(frame);
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.eventId !== undefined) {
        if (holdNotifications) {
          heldNotifications.push({ frame, raw: String(raw), route });
          return;
        }
        if (armGap && frame.params?.event?.type === 'RUN_STARTED') {
          holdNotifications = true;
        } else if (rejectedReplay) {
          deliveredLiveEventsAfterGap += 1;
        }
      }
      if (frame.id !== undefined && replayIds.delete(frame.id)) {
        if (!rejectedReplay) {
          rejectedReplay = true;
          route.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32001, message: 'Temporary replay overload' },
            }),
          );
          return;
        }
        recoveredTerminal ||= Boolean(
          frame.result?.events?.some((event) => event.params?.event?.type === 'RUN_FINISHED'),
        );
      }
      route.send(raw);
    });
  });

  const app = await createApp({ chatId: E2E_THREADS.layout });
  const route = page.url();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);

  await test.step('baseline', async () => {
    await expect(selectors.composerInput(page)).toBeEditable();
    await expect(selectors.composerSubmitSlot(page)).toBeVisible();
    expect(replayRequests).toHaveLength(0);
  });

  await test.step('trigger', async () => {
    armGap = true;
    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.layout,
      messageId: 'retry-answer',
      chunks: ['Recovered after a transient replay error.'],
      whileRunning: async () => {
        await expect(selectors.composerStopSlot(page)).toBeVisible();
        expect(heldNotifications.length).toBeGreaterThan(0);
      },
    });
    await expect
      .poll(() =>
        heldNotifications.some(({ frame }) => frame.params?.event?.type === 'RUN_FINISHED'),
      )
      .toBe(true);
    const terminal = heldNotifications.find(
      ({ frame }) => frame.params?.event?.type === 'RUN_FINISHED',
    );
    if (!terminal) throw new Error('The real bridge did not emit turn completion');
    terminal.route.send(terminal.raw);
    await expect.poll(() => rejectedReplay).toBe(true);
  });

  await test.step('recovery', async () => {
    await expect.poll(() => recoveredTerminal, { timeout: 10_000 }).toBe(true);
    expect(replayRequests).toHaveLength(2);
    expect(replayRequests[1]?.params?.afterEventId).toBe(replayRequests[0]?.params?.afterEventId);
    expect(deliveredLiveEventsAfterGap).toBe(0);
    await expect(
      selectors
        .assistantMessages(page)
        .filter({ hasText: 'Recovered after a transient replay error.' }),
    ).toHaveCount(1);
    await expect(selectors.composerStopSlot(page)).toHaveCount(0);
    await expect(selectors.runningGlyph(page)).toHaveCount(0);
    await expect(selectors.composerSubmitSlot(page)).toBeVisible();
    await expect(selectors.composerInput(page)).toBeEditable();
    await expect(selectors.activityError(page)).toHaveCount(0);
  });

  await test.step('confirmation', async () => {
    armGap = false;
    holdNotifications = false;
    const followup = await app.bridge.prepareAssistantTurn({
      messageId: 'retry-followup',
      chunks: ['The recovered connection remains usable.'],
    });
    await selectors.composerInput(page).fill('Confirm the connection still works.');
    await selectors.composerSend(page).click();
    await followup.waitForStart();
    await expect(selectors.composerStopSlot(page)).toBeVisible();
    await followup.release();
    await expect(
      selectors
        .assistantMessages(page)
        .filter({ hasText: 'The recovered connection remains usable.' }),
    ).toHaveCount(1);
    await expect(selectors.composerStopSlot(page)).toHaveCount(0);
    await expect(selectors.runningGlyph(page)).toHaveCount(0);
    await expect(selectors.composerInput(page)).toBeEditable();
    expect(page.url()).toBe(route);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  });
});
