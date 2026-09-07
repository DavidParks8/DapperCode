import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';
import { scenarioThreadId } from '../harness/scenario.ts';

for (const delayedPrompt of [false, true]) {
  test(`a fresh composer receives a reply and a follow-up${delayedPrompt ? ' while the first prompt snapshot lags' : ''}`, async ({
    createApp,
    page,
  }) => {
    let firstTurn = true;
    let firstThreadReads = 0;
    const threadId = scenarioThreadId('e2e-new-session');
    await page.routeWebSocket('**/rpc*', (route) => {
      const server = route.connectToServer();
      route.onMessage((raw) => server.send(raw));
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        const thread = frame.result?.thread;
        if (thread?.id === threadId && thread.acpSnapshot && firstTurn) {
          firstThreadReads += 1;
          if (delayedPrompt) {
            const snapshot = thread.acpSnapshot;
            const promptIds = new Set(
              snapshot.messages
                .filter((message: { role: string }) => message.role === 'user')
                .map((message: { id: string }) => message.id),
            );
            snapshot.messages = snapshot.messages.filter(
              (message: { id: string }) => !promptIds.has(message.id),
            );
            snapshot.timeline = snapshot.timeline.filter(
              (entry: { canonicalId: string }) => !promptIds.has(entry.canonicalId),
            );
            route.send(JSON.stringify(frame));
            return;
          }
        }
        route.send(raw);
      });
    });
    const app = await createApp();
    await app.openDrawer();
    await selectors.drawerNewChat(page).click();
    await expect(selectors.composerInput(page)).toBeEditable();
    const answers: string[] = [];
    for (const [index, prompt] of ['Start the first task.', 'Now continue the task.'].entries()) {
      const answer = `Completed composer task ${String(index + 1)}.`;
      const turn = await app.bridge.prepareAssistantTurn({
        messageId: `composer-answer-${String(index)}`,
        chunks: [answer],
      });
      await selectors.composerInput(page).fill(prompt);
      await selectors.composerSend(page).click();
      await expect(selectors.userMessages(page).filter({ hasText: prompt })).toBeVisible();
      await turn.waitForStart();
      for (const previous of answers) {
        await expect(selectors.assistantMessages(page).filter({ hasText: previous })).toBeVisible();
      }
      await expect(selectors.composerStopSlot(page)).toBeVisible();
      await turn.release();
      await expect(selectors.assistantMessages(page).filter({ hasText: answer })).toBeVisible();
      await expect(selectors.composerStopSlot(page)).toHaveCount(0);
      await expect(selectors.runningGlyph(page)).toHaveCount(0);
      await expect(selectors.composerInput(page)).toBeEditable();
      await expect(selectors.activityError(page)).toHaveCount(0);
      if (firstTurn) {
        const readsAtCompletion = firstThreadReads;
        await expect
          .poll(() => firstThreadReads, { timeout: 20_000 })
          .toBeGreaterThan(readsAtCompletion + 1);
        await expect(selectors.assistantMessages(page).filter({ hasText: answer })).toBeVisible();
        await expect(selectors.userMessages(page).filter({ hasText: prompt })).toHaveCount(1);
        await expect(selectors.composerStopSlot(page)).toHaveCount(0);
        await expect(selectors.runningGlyph(page)).toHaveCount(0);
        firstTurn = false;
      }
      await expect(selectors.historyRecovery(page)).toHaveCount(0);
      answers.push(answer);
    }
    await expect(selectors.userMessages(page)).toHaveCount(2);
    await expect(selectors.assistantMessages(page)).toHaveCount(2);
  });
}
