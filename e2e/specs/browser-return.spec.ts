import { chatRoute, expect, test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import { E2E_THREADS } from '../harness/scenario.ts';
import { expectNoOverlap, expectTouchTarget, expectWithinViewport } from '../layout/assertions.ts';

test('returns from a localhost response link to the same chat and draft even when preview is unavailable', async ({
  createApp,
}, testInfo) => {
  const targetUrl = 'http://localhost:3000/';
  const app = await createApp({
    chatId: E2E_THREADS.layout,
    scenario: {
      chats: [
        {
          id: 'thread-layout',
          title: 'Preview source chat',
          messages: [{ role: 'assistant', text: `Your app is ready at ${targetUrl}` }],
        },
      ],
    },
  });
  const { page } = app;
  const draft = 'Keep this unsent feedback';
  await selectors.composerInput(page).fill(draft);

  for (let visit = 0; visit < 2; visit += 1) {
    await selectors.chatPreviewLink(page, targetUrl).click();
    await expect(page).toHaveURL(/\/browser\?returnChatId=/);
    await expect(selectors.browserUnavailable(page)).toBeVisible();

    const backToChat = selectors.browserReturnToChat(page);
    await expect(backToChat).toContainText('Back to chat');
    await expectTouchTarget(backToChat, 48);
    await expectWithinViewport(backToChat);
    await expectNoOverlap(backToChat, selectors.browserAddress(page));
    if (visit === 0) {
      await page.screenshot({ path: testInfo.outputPath('browser-return.png') });
    }

    await backToChat.click();
    await expect(page).toHaveURL(new RegExp(`${chatRoute(E2E_THREADS.layout)}$`));
    await expect(selectors.topChrome(page)).toBeVisible();
    await expect(selectors.composerInput(page)).toHaveValue(draft);
    await expect(selectors.chatPreviewLink(page, targetUrl)).toBeVisible();
  }
});
