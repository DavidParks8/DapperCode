import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { E2E_THREADS, FIXED_NOW_MS, scenarioThreadId } from '../harness/scenario.ts';

test('completed output is reconstructed after the bridge evicts a backgrounded session', async ({
  createApp,
  page,
}) => {
  test.setTimeout(120_000);
  // The production ACP session registry holds 256 entries per agent.
  const otherChats = Array.from({ length: 256 }, (_, index) => ({
    id: `eviction-${index}`,
    title: `Other chat ${index}`,
    messages: [],
  }));
  const app = await createApp({
    chatId: E2E_THREADS.layout,
    scenario: {
      chats: [{ id: 'thread-layout', title: 'Recover this chat', messages: [] }, ...otherChats],
    },
  });
  const prompt = 'Keep the answer when this session leaves bridge memory.';
  const answer = 'This answer was produced while the phone was locked.';
  const turn = await app.bridge.prepareAssistantTurn({
    messageId: 'cold-answer',
    chunks: [answer],
  });
  await selectors.composerInput(page).fill(prompt);
  await selectors.composerSend(page).click();
  await turn.waitForStart();
  await expect(selectors.userMessages(page)).toContainText(prompt);
  await expect(selectors.composerStopSlot(page)).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.context().setOffline(true);
  await page.clock.setSystemTime(FIXED_NOW_MS + 25 * 60_000);
  await turn.release();
  const read = async () =>
    app.bridge.request('thread/read', { threadId: E2E_THREADS.layout }) as Promise<{
      thread: {
        name: string;
        acpSnapshot: { active: { runId?: string | null }; messages: Array<{ parts: unknown[] }> };
      };
    }>;
  await expect
    .poll(async () => {
      const snapshot = (await read()).thread.acpSnapshot;
      return !snapshot.active.runId && JSON.stringify(snapshot.messages).includes(answer);
    })
    .toBe(true);

  for (const chat of otherChats) {
    await app.bridge.request('thread/read', { threadId: scenarioThreadId(chat.id) });
  }
  const loaded = (await app.bridge.request('thread/loaded/list', {})) as { data: string[] };
  expect(loaded.data).toHaveLength(256);
  expect(loaded.data).not.toContain(E2E_THREADS.layout);

  // A public read must reconstruct both messages. The fixture's resume intentionally omits them.
  const restored = (await read()).thread;
  expect(restored.name).toBe('Recover this chat');
  expect(restored.acpSnapshot.active.runId).toBeNull();
  expect(restored.acpSnapshot.messages.map((message) => message.parts)).toEqual([
    [{ type: 'text', text: prompt }],
    [{ type: 'text', text: answer }],
  ]);
  await page.context().setOffline(false);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(selectors.assistantMessages(page).filter({ hasText: answer })).toHaveCount(1);
  await expect(selectors.userMessages(page).filter({ hasText: prompt })).toHaveCount(1);
  await expect(selectors.composerStopSlot(page)).toHaveCount(0);
  await expect(selectors.runningGlyph(page)).toHaveCount(0);
  await expect(selectors.composerInput(page)).toBeEditable();
  await expect(selectors.historyRecovery(page)).toHaveCount(0);
});
