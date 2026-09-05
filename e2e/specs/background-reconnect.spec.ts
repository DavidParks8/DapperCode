import type { Page } from '@playwright/test';

import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { E2E_THREADS, FIXED_NOW_MS, scenarioThreadId } from '../harness/scenario.ts';
import type { RealBridge } from '../harness/realBridge.ts';

const kickoff = 'Complete the long task while this phone is locked.';
const deletedThreadId = scenarioThreadId('deleted-while-offline');
const chunks = [
  'Offline answer begins. ',
  ...Array.from({ length: 2_100 }, (_, index) => `Offline progress ${index}.`),
  'Offline answer complete.',
];

interface Snapshot {
  active: { runId?: string | null };
  messages: Array<{ id: string; role: string; parts: unknown[] }>;
  messageCollection: { truncated: boolean; omittedCount: number };
}

interface EventFrame {
  method?: string;
  params?: { event?: { type?: string; delta?: string } };
}

test('same-session transcript recovers after offline replay overflow and a cached chat deletion', async ({
  createApp,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  let opened = 0;
  let closed = 0;
  let lastEventId = 0;
  let received = 0;
  let textDeltasAfterDisconnect = 0;
  let liveTextDeltasAfterDisconnect = 0;
  let finalAnswerDeltasAfterDisconnect = 0;
  let boundedSnapshotsReceived = 0;
  let deletedThreadConfirmedMissing = false;
  const observedUserMessages = new Map<string, unknown[]>();
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/rpc') return;
    opened += 1;
    socket.on('close', () => {
      closed += 1;
    });
    socket.on('framereceived', ({ payload }) => {
      received += 1;
      const frame = JSON.parse(String(payload)) as EventFrame & {
        eventId?: number;
        result?: {
          events?: EventFrame[];
          thread?: { acpSnapshot?: Snapshot };
          entries?: Array<{ message?: Snapshot['messages'][number] }>;
        };
        error?: { code?: number; data?: { error?: string; threadId?: string } };
      };
      if (
        frame.error?.code === -32004 &&
        frame.error.data?.error === 'thread_not_found' &&
        frame.error.data.threadId === deletedThreadId
      ) {
        deletedThreadConfirmedMissing = true;
      }
      if (typeof frame.eventId === 'number') lastEventId = Math.max(lastEventId, frame.eventId);
      for (const event of [frame, ...(frame.result?.events ?? [])]) {
        if (
          event.method === 'bridge/agui.event' &&
          event.params?.event?.type === 'TEXT_MESSAGE_CONTENT'
        ) {
          textDeltasAfterDisconnect += 1;
          if (event === frame) liveTextDeltasAfterDisconnect += 1;
          if (event.params.event.delta?.includes('Offline answer complete.')) {
            finalAnswerDeltasAfterDisconnect += 1;
          }
        }
      }
      const snapshot = frame.result?.thread?.acpSnapshot;
      for (const message of [
        ...(snapshot?.messages ?? []),
        ...(Array.isArray(frame.result?.entries)
          ? frame.result.entries.flatMap((entry) => (entry.message ? [entry.message] : []))
          : []),
      ]) {
        if (message.role === 'user') observedUserMessages.set(message.id, message.parts);
      }
      if (snapshot?.messageCollection.truncated && snapshot.messageCollection.omittedCount > 0) {
        boundedSnapshotsReceived += 1;
      }
    });
  });
  await page.clock.setSystemTime(FIXED_NOW_MS);
  const app = await createApp({
    chatId: deletedThreadId,
    scenario: {
      chats: [
        { id: 'thread-layout', title: 'Background recovery', messages: [] },
        {
          id: 'deleted-while-offline',
          title: 'Previously opened chat',
          messages: [{ role: 'assistant', text: 'Cached before disconnect' }],
        },
      ],
    },
  });
  await expect(
    selectors.assistantMessages(page).filter({ hasText: 'Cached before disconnect' }),
  ).toBeVisible();
  await app.openDrawer();
  await selectors.drawerChatRow(page, E2E_THREADS.layout).click();
  await expect
    .poll(() => new URL(page.url()).pathname.endsWith(`/chats/${E2E_THREADS.layout}`))
    .toBe(true);
  await expect(selectors.assistantMessages(page)).toHaveCount(0);
  const route = page.url();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const prompt = await app.bridge.prepareAssistantTurn({
    messageId: 'initial-turn',
    chunks: [],
  });
  let disconnectedCursor = 0;
  let disconnectedFrames = 0;

  await test.step('baseline', async () => {
    await expect(selectors.transcriptScroll(page)).toHaveCSS('overflow-anchor', 'none');
    await selectors.composerInput(page).fill(kickoff);
    await selectors.composerSend(page).click();
    await prompt.waitForStart();
    await expect(selectors.userMessages(page)).toContainText(kickoff);
    await expect(selectors.assistantMessages(page)).toHaveCount(0);
    await expect(selectors.composerStopSlot(page)).toBeVisible();
    await expect(selectors.runningGlyph(page)).toBeVisible();
    expect(opened).toBeGreaterThan(0);
    expect(lastEventId).toBeGreaterThan(0);
  });

  await test.step('trigger', async () => {
    await setVisibility(page, 'hidden');
    await expect.poll(() => closed).toBe(opened);
    await page.context().setOffline(true);
    disconnectedCursor = lastEventId;
    disconnectedFrames = received;
    textDeltasAfterDisconnect = 0;
    liveTextDeltasAfterDisconnect = 0;
    finalAnswerDeltasAfterDisconnect = 0;
    // Elapsed wall time is compressed; output volume, framing and disconnects remain real.
    await page.clock.setSystemTime(FIXED_NOW_MS + 45 * 60_000);
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
    expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(
      FIXED_NOW_MS + 45 * 60_000,
    );
    await prompt.release();
    await expect.poll(async () => (await readSnapshot(app.bridge)).active.runId == null).toBe(true);
    // A second client deletes the cached chat and continues working while the phone stays offline.
    await app.bridge.request('thread/delete', { threadId: deletedThreadId });
    const offlineWork = await app.bridge.prepareAssistantTurn({
      messageId: 'offline-answer',
      chunks,
      separateMessages: true,
    });
    await app.bridge.request('turn/start', {
      threadId: E2E_THREADS.layout,
      input: [{ type: 'text', text: 'Continue the background work.', text_elements: [] }],
    });
    await offlineWork.waitForStart();
    await offlineWork.release();
  });

  await test.step('missed-output', async () => {
    await expect
      .poll(
        async () => {
          const snapshot = await readSnapshot(app.bridge);
          return (
            snapshot.active.runId == null &&
            snapshot.messages.some((message) =>
              JSON.stringify(message.parts).includes('Offline answer complete.'),
            )
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const replay = (await app.bridge.request('bridge/events/replay', {
      afterEventId: disconnectedCursor,
      limit: 1,
    })) as { earliestEventId: number; latestEventId: number };
    expect(replay.earliestEventId).toBeGreaterThan(disconnectedCursor + 1);
    expect(replay.latestEventId - disconnectedCursor).toBeGreaterThan(2_000);
    const snapshot = await readSnapshot(app.bridge);
    expect(snapshot.messages).toHaveLength(128);
    expect(new Set(snapshot.messages.map((message) => message.role))).toEqual(new Set(['agent']));
    expect(snapshot.messageCollection.truncated).toBe(true);
    expect(snapshot.messageCollection.omittedCount).toBeGreaterThan(0);
    expect(boundedSnapshotsReceived).toBe(0);
    expect(liveTextDeltasAfterDisconnect).toBe(0);
    expect(finalAnswerDeltasAfterDisconnect).toBe(0);
    expect(received).toBe(disconnectedFrames);
    await expect(selectors.userMessages(page)).toContainText(kickoff);
    await expect(selectors.assistantMessages(page)).toHaveCount(0);
  });

  await test.step('recovery', async () => {
    await page.context().setOffline(false);
    expect(opened).toBe(closed);
    await setVisibility(page, 'visible');
    await expect.poll(() => opened - closed).toBe(1);
    try {
      await expect.poll(() => boundedSnapshotsReceived).toBeGreaterThan(0);
      // A truncated replay page may contain older progress, but cannot supply the final answer.
      expect(liveTextDeltasAfterDisconnect).toBe(0);
      expect(finalAnswerDeltasAfterDisconnect).toBe(0);
      await expect(
        selectors.assistantMessages(page).filter({ hasText: 'Offline answer complete.' }),
      ).toBeInViewport();
      await expectSettled(page);
      await expect.poll(() => deletedThreadConfirmedMissing).toBe(true);
      await expect(selectors.scrollRailBars(page)).toHaveCount(1);
      await expectKickoffRetained(page, 'Offline answer complete.');
      expect(textDeltasAfterDisconnect).toBeLessThan(chunks.length);
      expect(page.url()).toBe(route);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    } finally {
      await testInfo.attach('reconnect-observation', {
        contentType: 'application/json',
        body: JSON.stringify({
          opened,
          closed,
          disconnectedCursor,
          lastEventId,
          textDeltasAfterDisconnect,
          liveTextDeltasAfterDisconnect,
          finalAnswerDeltasAfterDisconnect,
          boundedSnapshotsReceived,
          deletedThreadConfirmedMissing,
          sameRoute: page.url() === route,
          sameDocument: (await page.evaluate(() => performance.timeOrigin)) === timeOrigin,
          assistantCount: await selectors.assistantMessages(page).count(),
          assistantTextLength: (await selectors.assistantMessages(page).allTextContents()).join('')
            .length,
          userCount: await selectors.userMessages(page).count(),
          activity: await selectors.activityEvent(page).allTextContents(),
          stopCount: await selectors.composerStopSlot(page).count(),
          sendCount: await selectors.composerSend(page).count(),
          runningGlyphCount: await selectors.runningGlyph(page).count(),
          scrollRailBars: await selectors
            .scrollRailBars(page)
            .evaluateAll((bars) => bars.map((bar) => bar.getAttribute('data-testid'))),
          scroll: await selectors.transcriptScroll(page).evaluate((element) => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            viewport: element.clientHeight,
          })),
        }),
      });
    }
  });

  await test.step('confirmation', async () => {
    await setVisibility(page, 'hidden');
    await expect.poll(() => closed).toBe(opened);
    await setVisibility(page, 'visible');
    await expect.poll(() => opened - closed).toBe(1);
    await expectSettled(page);
    await expect(
      selectors.assistantMessages(page).filter({ hasText: 'Offline answer complete.' }),
    ).toBeInViewport();
    await expect(selectors.scrollRailBars(page)).toHaveCount(1);
    expect(liveTextDeltasAfterDisconnect).toBe(0);
    expect(finalAnswerDeltasAfterDisconnect).toBe(0);

    const followup = await app.bridge.prepareAssistantTurn({
      messageId: 'followup-answer',
      chunks: ['Follow-up completed after reconnect.'],
    });
    await selectors.composerInput(page).fill('Now confirm the recovered session still works.');
    await expect(selectors.composerSend(page)).toBeEnabled();
    await selectors.composerSend(page).click();
    await followup.waitForStart();
    await expect(selectors.composerStopSlot(page)).toBeVisible();
    await expect(selectors.runningGlyph(page)).toBeVisible();
    await Promise.all([
      expect(selectors.activityEvent(page)).toHaveAttribute('aria-label', /^Turn completed(?:,|$)/),
      followup.release(),
    ]);
    await expectSettled(page);
    await expect(
      selectors.assistantMessages(page).filter({ hasText: 'Follow-up completed after reconnect.' }),
    ).toBeInViewport();
    await expect(
      selectors
        .userMessages(page)
        .filter({ hasText: 'Now confirm the recovered session still works.' }),
    ).toHaveCount(1);
    try {
      await expect(selectors.scrollRailBars(page)).toHaveCount(2);
    } finally {
      await testInfo.attach('reconnect-observation', {
        contentType: 'application/json',
        body: JSON.stringify({
          boundary: 'after-followup',
          scrollRailBars: await selectors
            .scrollRailBars(page)
            .evaluateAll((bars) => bars.map((element) => element.getAttribute('data-testid'))),
          renderedUsers: await selectors.userMessages(page).evaluateAll((elements) =>
            elements.map((element) => ({
              id: element.getAttribute('data-testid'),
              text: element.textContent,
            })),
          ),
          observedUserMessages: [...observedUserMessages].map(([id, parts]) => ({ id, parts })),
          activity: await selectors.activityEvent(page).allTextContents(),
          stopCount: await selectors.composerStopSlot(page).count(),
          sendCount: await selectors.composerSend(page).count(),
          runningGlyphCount: await selectors.runningGlyph(page).count(),
        }),
      });
    }
    await expectKickoffRetained(page, 'Follow-up completed after reconnect.');
    await expectSettled(page);
    expect(liveTextDeltasAfterDisconnect).toBeGreaterThan(0);
    expect(page.url()).toBe(route);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await app.openDrawer();
    await expect(selectors.drawerChatRow(page, deletedThreadId)).toHaveCount(0);
    await expect(selectors.drawerChatRow(page, E2E_THREADS.layout)).toBeVisible();
  });
});

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

async function expectKickoffRetained(page: Page, latestAnswer: string): Promise<void> {
  // The rail targets the cached kickoff even while older pages change the virtualized window.
  const scroll = selectors.transcriptScroll(page);
  const message = selectors.userMessages(page).filter({ hasText: kickoff });
  const bar = selectors.scrollRailBars(page).first();
  await expect(bar).toHaveCount(1);
  let kickoffVerified = false;
  let gestureCount = 0;
  try {
    await expect(async () => {
      const bounds = await bar.boundingBox();
      expect(bounds).not.toBeNull();
      const { x, y, width, height } = bounds!;
      await page.mouse.move(x + width - 2, y + height / 2);
      await page.mouse.down();
      gestureCount += 1;
      try {
        // Repeat the real rail gesture if newly paged history moves the virtualized target.
        await page.waitForTimeout(250);
        await page.mouse.move(x + width - 2, y + height / 2 - 12, { steps: 3 });
        await expect(selectors.jumpToLatest(page)).toBeVisible({ timeout: 1_000 });
      } finally {
        await page.mouse.up();
      }
      // Paging can move the virtualized target after the rail jump. Finish revealing the
      // retained prefix through the same scroll container instead of racing another measurement.
      if (!(await message.count())) {
        await scroll.evaluate((element) => {
          // React Native Web replaces scrollTo with its (y, x) API, not the DOM (x, y) API.
          element.scrollTop = element.scrollHeight;
        });
      }
      if (await message.count()) {
        await message.scrollIntoViewIfNeeded({ timeout: 500 });
      }
      await expect(message).toHaveCount(1, { timeout: 500 });
      await expect(message).toBeInViewport({ timeout: 500 });
    }).toPass({ timeout: 30_000, intervals: [100, 250, 500] });
    kickoffVerified = true;
  } finally {
    await page.mouse.up();
    await test.info().attach('reconnect-observation', {
      contentType: 'application/json',
      body: JSON.stringify({
        boundary: 'kickoff-after-rail-gesture',
        kickoffVerified,
        gestureCount,
        scrollRailBars: await selectors
          .scrollRailBars(page)
          .evaluateAll((bars) => bars.map((element) => element.getAttribute('data-testid'))),
        renderedUsers: await selectors.userMessages(page).allTextContents(),
        jumpToLatestCount: await selectors.jumpToLatest(page).count(),
        scroll: await selectors.transcriptScroll(page).evaluate((element) => ({
          top: element.scrollTop,
          height: element.scrollHeight,
          viewport: element.clientHeight,
        })),
      }),
    });
  }
  await selectors.jumpToLatest(page).click();
  await expect(
    selectors.assistantMessages(page).filter({ hasText: latestAnswer }),
  ).toBeInViewport();
  await expect(selectors.jumpToLatest(page)).toHaveCount(0);
}

async function expectSettled(page: Page): Promise<void> {
  await expect(selectors.composerStopSlot(page)).toHaveCount(0);
  await expect(selectors.composerSubmitSlot(page)).toBeVisible();
  await expect(selectors.composerInput(page)).toBeEditable();
  await expect(selectors.runningGlyph(page)).toHaveCount(0);
  await expect(selectors.activityError(page)).toHaveCount(0);
  // Snapshot-only recovery can be idle: unlike a live RUN_FINISHED it has no verdict to display.
  await expect
    .poll(async () => {
      const labels = await selectors
        .activityEvent(page)
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
      return labels.every(
        (label) => label === 'Connected' || /^Turn completed(?:,|$)/.test(label ?? ''),
      );
    })
    .toBe(true);
}

async function readSnapshot(bridge: RealBridge): Promise<Snapshot> {
  const response = (await bridge.request('thread/read', {
    threadId: E2E_THREADS.layout,
    includeTurns: true,
  })) as { thread: { acpSnapshot: Snapshot } };
  return response.thread.acpSnapshot;
}
