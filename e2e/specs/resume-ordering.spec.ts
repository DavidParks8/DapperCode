import type { Page } from '@playwright/test';

import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { E2E_THREADS } from '../harness/scenario.ts';

const firstPrompt = 'Finish the first task.';
const secondPrompt = 'Continue with the second task.';

test('keeps a second prompt ahead of tool output when returning during the turn', async ({
  createApp,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  let lockOnSend = false;
  let opened = 0;
  let closed = 0;
  const events: unknown[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/rpc') return;
    opened += 1;
    socket.on('close', () => {
      closed += 1;
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.params?.event || frame.result?.thread?.acpSnapshot) {
        events.push(frame.params?.event ?? frame.result.thread.acpSnapshot);
      }
    });
  });
  await page.routeWebSocket('**/rpc*', (route) => {
    const server = route.connectToServer();
    let lockingSubmissionId: string | number | undefined;
    route.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (lockOnSend && frame.method === 'bridge/thread/queue/send') {
        lockOnSend = false;
        lockingSubmissionId = frame.id;
      }
      server.send(raw);
    });
    server.onMessage(async (raw) => {
      const frame = JSON.parse(String(raw));
      // Suspend delivery until the next connection, after the send is acknowledged but
      // before the phone receives this turn's kickoff and tool notifications.
      if (lockingSubmissionId !== undefined && frame.id !== lockingSubmissionId) return;
      route.send(raw);
      if (lockingSubmissionId !== undefined) {
        await setVisibility(page, 'hidden');
      }
    });
  });
  const app = await createApp({
    chatId: E2E_THREADS.layout,
    scenario: { chats: [{ id: 'thread-layout', title: 'Resume ordering', messages: [] }] },
  });
  const route = page.url();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  try {
    await test.step('complete the first turn with the app open', async () => {
      const first = await app.bridge.prepareAssistantTurn({
        messageId: 'first-answer',
        chunks: ['First task complete.'],
      });
      await selectors.composerInput(page).fill(firstPrompt);
      await selectors.composerSend(page).click();
      await first.waitForStart();
      await first.release();
      await expect(selectors.assistantMessages(page)).toContainText('First task complete.');
      await expectSettled(page);
    });

    const second = await app.bridge.prepareAssistantTurn({
      messageId: 'second-answer',
      chunks: ['Second task complete.'],
      toolSteps: Array.from({ length: 3 }, (_, index) => ({
        update: {
          sessionUpdate: 'tool_call' as const,
          toolCallId: `resume-tool-${String(index)}`,
          title: `Resume step ${String(index + 1)}`,
          kind: 'other' as const,
          status: 'completed' as const,
        },
        whilePaused: async () => {
          if (index === 0) {
            await test.step('unlock before the second turn finishes', async () => {
              await expect.poll(() => opened === closed).toBe(true);
              expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
              await setVisibility(page, 'visible');
              await expect.poll(() => opened - closed).toBe(1);
            });
          }
          await test.step(`keep the prompt above tool ${String(index + 1)}`, async () => {
            await expect(selectors.toolRows(page)).toHaveCount(index + 1);
            await expect(selectors.composerStopSlot(page)).toBeVisible();
            await expect(selectors.runningGlyph(page)).toBeVisible();
            await expectPromptBeforeOutput(page);
          });
        },
      })),
    });
    await selectors.composerInput(page).fill(secondPrompt);
    lockOnSend = true;
    await selectors.composerSend(page).click();
    await second.waitForStart();
    await second.release();

    await test.step('settle and repeat foreground recovery without moving the prompt', async () => {
      await expect(
        selectors.assistantMessages(page).filter({ hasText: 'Second task complete.' }),
      ).toBeVisible();
      await expectSettled(page);
      await expectPromptBeforeOutput(page);
      await setVisibility(page, 'hidden');
      await expect.poll(() => opened === closed).toBe(true);
      await setVisibility(page, 'visible');
      await expect.poll(() => opened - closed).toBe(1);
      await expectPromptBeforeOutput(page);
      await expectSettled(page);
      expect(page.url()).toBe(route);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    });
  } finally {
    await testInfo.attach('resume-ordering-events', {
      contentType: 'application/json',
      body: JSON.stringify(events),
    });
  }
});

async function expectPromptBeforeOutput(page: Page): Promise<void> {
  const prompt = selectors.userMessages(page).filter({ hasText: secondPrompt });
  await expect(prompt).toHaveCount(1);
  await expect(selectors.userMessages(page)).toHaveCount(2);
  const promptBox = await prompt.boundingBox();
  expect(promptBox).not.toBeNull();
  for (const output of await selectors.toolRows(page).all()) {
    const box = await output.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(promptBox!.y + promptBox!.height);
  }
  const answer = selectors.assistantMessages(page).filter({ hasText: 'Second task complete.' });
  if (await answer.count()) {
    expect((await answer.boundingBox())!.y).toBeGreaterThanOrEqual(
      promptBox!.y + promptBox!.height,
    );
  }
}

async function expectSettled(page: Page): Promise<void> {
  await expect(selectors.composerStopSlot(page)).toHaveCount(0);
  await expect(selectors.runningGlyph(page)).toHaveCount(0);
  await expect(selectors.composerSubmitSlot(page)).toBeVisible();
  await expect(selectors.composerInput(page)).toBeEditable();
  await expect(selectors.activityError(page)).toHaveCount(0);
}

async function setVisibility(page: Page, visibility: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => value === 'hidden',
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}
