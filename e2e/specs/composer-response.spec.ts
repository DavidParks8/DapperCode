import { selectors } from '../fixtures/selectors.ts';
import { expect, test } from '../fixtures/test.ts';

test('a fresh composer creates a chat, receives a reply, and accepts a follow-up', async ({
  createApp,
  page,
}) => {
  const app = await createApp();
  await app.openDrawer();
  await selectors.drawerNewChat(page).click();
  await expect(selectors.composerInput(page)).toBeEditable();
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
    await expect(selectors.composerStopSlot(page)).toBeVisible();
    await turn.release();
    await expect(selectors.assistantMessages(page).filter({ hasText: answer })).toBeVisible();
    await expect(selectors.composerStopSlot(page)).toHaveCount(0);
    await expect(selectors.runningGlyph(page)).toHaveCount(0);
    await expect(selectors.composerInput(page)).toBeEditable();
    await expect(selectors.activityError(page)).toHaveCount(0);
  }
  await expect(selectors.userMessages(page)).toHaveCount(2);
  await expect(selectors.assistantMessages(page)).toHaveCount(2);
});
