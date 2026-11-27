import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import {
  expectContainedWithin,
  expectHorizontalGap,
  expectLeftAligned,
  expectNoOverlap,
  expectRightAligned,
  expectStackedVertically,
  expectSymmetricHorizontalInsets,
  expectTouchTarget,
  expectVerticalGap,
  expectVisible,
  expectWithinViewport,
} from '../layout/assertions.ts';
import { readRect, readViewportRect } from '../layout/geometry.ts';
import { expect } from '@playwright/test';
import { E2E_THREADS, scenarioThreadId } from '../harness/scenario.ts';

test.describe('chat screen layout', () => {
  test('the composer is anchored to the bottom without covering the transcript', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const transcript = selectors.transcript(app.page);
    const composer = selectors.composer(app.page);

    await expectVisible(transcript);
    await expectVisible(composer);

    // The composer must own the space below the transcript rather than floating over it, which is
    // the regression that hides the newest message behind the input.
    await expectStackedVertically([transcript, composer]);
    await expectNoOverlap(transcript, composer);
    await expectVerticalGap(transcript, composer, 0);
    await expectWithinViewport(composer);

    // Width and left edge are compared against the chat pane, not the viewport: on a wide screen
    // the docked drawer legitimately takes the leading part of the window.
    const viewport = await readViewportRect(app.page);
    const [composerRect, transcriptRect] = await Promise.all([
      readRect(composer),
      readRect(transcript),
    ]);
    expect(Math.round(composerRect.bottom)).toBe(Math.round(viewport.bottom));
    expect(Math.round(composerRect.width)).toBe(Math.round(transcriptRect.width));
    expect(Math.round(composerRect.left)).toBe(Math.round(transcriptRect.left));
  });

  test('the composer controls keep symmetric insets and a single row', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const controls = selectors.composerControls(app.page);
    const inputSurface = selectors.composerInputSurface(app.page);
    const submit = selectors.composerSubmitSlot(app.page);

    await expectVisible(controls);
    await expectSymmetricHorizontalInsets(controls, selectors.composer(app.page));

    // The input and the send button share one row: they must not collide, and the button must stay
    // inside the control group rather than spilling past the trailing inset.
    await expectNoOverlap(inputSurface, submit);
    await expectHorizontalGap(inputSurface, submit, 8);
    await expectContainedWithin(inputSurface, controls);
    await expectContainedWithin(submit, controls);
    await expectRightAligned([controls, submit]);
  });

  test('the send control is a comfortable touch target', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    await expectTouchTarget(selectors.composerSubmitSlot(app.page));
  });

  test('transcript messages share a rail and stack in chronological order', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const userMessage = selectors
      .userMessages(app.page)
      .filter({ hasText: 'Why does the composer overlap the transcript?' });
    const assistantMessage = selectors
      .assistantMessages(app.page)
      .filter({ hasText: 'The transcript uses a fixed bottom inset' });

    await expectVisible(userMessage);
    await expectVisible(assistantMessage);

    // The list renders inverted, so this also guards against the rows being painted in reverse.
    await expectStackedVertically([userMessage, assistantMessage]);
    await expectLeftAligned([userMessage, assistantMessage]);
    await expectRightAligned([userMessage, assistantMessage]);
  });

  test('messages clear the top chrome and never slide under the composer', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const topChrome = selectors.topChrome(app.page);
    const composer = selectors.composer(app.page);
    const messages = selectors.messages(app.page);

    await expect(messages).toHaveCount(2);
    const first = messages.first();
    const last = messages.last();

    await expectNoOverlap(topChrome, first);
    await expectNoOverlap(composer, first);
    await expectNoOverlap(composer, last);
    await expectContainedWithin(first, selectors.transcript(app.page));
    await expectContainedWithin(last, selectors.transcript(app.page));
  });

  test('the header rows stay inside the top chrome', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const topChrome = selectors.topChrome(app.page);

    await expectContainedWithin(selectors.chatHeaderRow(app.page), topChrome);
    await expectContainedWithin(selectors.sessionMetaRow(app.page), topChrome);
    await expectWithinViewport(topChrome);
  });

  test('the header starts a new chat without obscuring its other controls', async ({
    createApp,
  }) => {
    const app = await createApp({ chatId: E2E_THREADS.longTitle });
    const newChat = selectors.chatHeaderNewChat(app.page);
    const title = selectors.chatHeaderTitleRow(app.page);
    const edit = selectors.chatHeaderEditTitle(app.page);
    const git = selectors.chatHeaderGit(app.page);

    await expectTouchTarget(newChat);
    await expectWithinViewport(newChat);
    await expectNoOverlap(title, edit);
    await expectNoOverlap(edit, git);
    await expectNoOverlap(git, newChat);
    await newChat.click();
    await expect(newChat).toHaveCount(0);
    await expect(selectors.composerInput(app.page)).toBeVisible();
    await expect(app.page).toHaveURL(/\/chats\/new$/);
    await app.openDrawer();
    await expect(selectors.drawerChatRow(app.page, E2E_THREADS.longTitle)).toBeVisible();
  });

  test('a long assistant answer wraps instead of widening the rail', async ({ createApp }) => {
    const app = await createApp({ chatId: E2E_THREADS.layout });
    const assistantMessage = selectors
      .assistantMessages(app.page)
      .filter({ hasText: 'The transcript uses a fixed bottom inset' });
    const transcript = selectors.transcript(app.page);

    // The seeded answer is deliberately long: it must gain height, not width.
    const [messageRect, transcriptRect] = await Promise.all([
      readRect(assistantMessage),
      readRect(transcript),
    ]);
    expect(messageRect.width).toBeLessThanOrEqual(transcriptRect.width);
    expect(messageRect.height).toBeGreaterThan(messageRect.width * 0.25);
    await expectContainedWithin(assistantMessage, transcript);
  });

  test('stacked workflow cards align with messages and preserve page-level transcript scrolling', async ({
    createApp,
  }) => {
    const threadId = scenarioThreadId('workflow-scroll');
    const messages = Array.from({ length: 16 }, (_, index) => ({
      id: `wf-msg-${String(index + 1)}`,
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text:
        index % 2 === 0
          ? `Turn ${String(index + 1)}: check workflow card alignment and scrolling.`
          : `Assistant turn ${String(index + 1)}: this response fills the readable message column so the transcript has plenty of scrollable history even when cards appear.`,
    }));
    const app = await createApp({
      chatId: threadId,
      scenario: {
        chats: [{ id: 'workflow-scroll', title: 'Workflow scrolling', messages }],
      },
    });

    for (const cardIndex of [1, 2, 3]) {
      await app.bridge.request('bridge/ui/present', {
        id: `workflow-stack-${String(cardIndex)}`,
        threadId,
        kind: 'goal',
        presentation: 'workflowCard',
        tone: 'neutral',
        title: `Workflow status ${String(cardIndex)}`,
        subtitle: `Card ${String(cardIndex)} summary`,
        blocks: [
          {
            type: 'keyValue',
            items: [
              { label: 'Status', value: 'Ended' },
              {
                label: 'Objective',
                value:
                  'Long multi-line objective detail that should stay bounded inside the top cards container instead of swallowing the transcript viewport.',
              },
            ],
          },
        ],
        actions: [],
        dismissible: true,
      });
    }

    const topCards = selectors.topCards(app.page);
    await expectVisible(topCards);
    await expect(selectors.workflowCards(app.page)).toHaveCount(3);
    await app.settle();

    const [topChromeRect, composerRect, workflowCardRect, assistantRect, transcriptRect] =
      await Promise.all([
        readRect(selectors.topChrome(app.page)),
        readRect(selectors.composer(app.page)),
        readRect(selectors.workflowCards(app.page).last()),
        readRect(selectors.assistantMessages(app.page).last()),
        readRect(selectors.transcript(app.page)),
      ]);

    // Workflow cards match the message column left/right edges and leave open reading room.
    expect(Math.abs(workflowCardRect.left - assistantRect.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(workflowCardRect.right - assistantRect.right)).toBeLessThanOrEqual(2);
    expect(composerRect.top - topChromeRect.bottom).toBeGreaterThanOrEqual(160);

    // Real pointer hit-testing and wheel scrolling inside the unobstructed reading area reach
    // the transcript directly (not trapped by topCardsRow) and move it into older history.
    const scroller = selectors.transcriptScroll(app.page);
    const beforeScroll = await scroller.evaluate((node) => ({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
    const scrollPoint = {
      x: transcriptRect.left + transcriptRect.width / 2,
      y: topChromeRect.bottom + (composerRect.top - topChromeRect.bottom) / 2,
    };
    const hitInTranscript = await scroller.evaluate(
      (node, point) => node.contains(document.elementFromPoint(point.x, point.y)),
      scrollPoint,
    );
    expect(hitInTranscript).toBe(true);
    // RN Web does not emit native drag callbacks for mouse wheel events, so a newly virtualized
    // cell on tall viewports can trigger pinned auto-follow back to 0; observe the wheel-driven
    // scroll displacement directly on the transcript scroller.
    const wheelMoved = scroller.evaluate(
      (node, start) =>
        new Promise<number>((resolve) => {
          const onScroll = () => {
            if (node.scrollTop > start) {
              node.removeEventListener('scroll', onScroll);
              resolve(node.scrollTop);
            }
          };
          node.addEventListener('scroll', onScroll);
          setTimeout(() => {
            node.removeEventListener('scroll', onScroll);
            resolve(node.scrollTop);
          }, 3000);
        }),
      beforeScroll.scrollTop,
    );
    await app.page.mouse.move(scrollPoint.x, scrollPoint.y);
    await app.page.mouse.wheel(0, -320);
    expect(await wheelMoved).toBeGreaterThan(beforeScroll.scrollTop);
  });

  test('ended phone-call cards dock cleanly above the composer without blocking transcript scrolling', async ({
    createApp,
  }) => {
    const threadId = scenarioThreadId('phone-call-scroll');
    const messages = Array.from({ length: 14 }, (_, index) => ({
      id: `call-msg-${String(index + 1)}`,
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text:
        index % 2 === 0
          ? `Call check ${String(index + 1)}`
          : `Call response ${String(index + 1)}: confirming the transcript remains readable and scrollable when call cards arrive.`,
    }));
    const app = await createApp({
      chatId: threadId,
      scenario: {
        chats: [{ id: 'phone-call-scroll', title: 'Phone call scrolling', messages }],
      },
    });

    for (const callIndex of [1, 2, 3]) {
      await app.bridge.request('bridge/ui/present', {
        id: `phone-call-live:call-${String(callIndex)}`,
        threadId,
        kind: callIndex === 1 ? null : 'phone-call',
        presentation: 'workflowCard',
        tone: 'neutral',
        title: 'Phone call ended',
        subtitle: 'Duration 3:15',
        blocks: [
          {
            type: 'keyValue',
            items: [
              { label: 'Status', value: 'Ended' },
              { label: 'To', value: '+15551234567' },
              { label: 'Duration', value: '3:15' },
              { label: 'Objective', value: 'Confirm prescription pickup window.' },
            ],
          },
        ],
        actions: [],
        dismissible: true,
        createdAt: `2026-11-26T18:0${String(callIndex)}:00.000Z`,
      });
    }

    const dock = selectors.phoneCallDock(app.page);
    await expect(dock).toHaveCount(1);
    await expect(selectors.topCards(app.page)).toHaveCount(0);
    await app.settle();

    // Expanding the docked call still preserves scrollable transcript space above it.
    await selectors.phoneCallDockToggle(app.page).click();
    await expectVisible(selectors.phoneCallDockDetails(app.page));
    await app.settle();

    const [topChromeRect, dockRect, transcriptRect] = await Promise.all([
      readRect(selectors.topChrome(app.page)),
      readRect(dock),
      readRect(selectors.transcript(app.page)),
    ]);
    expect(dockRect.top - topChromeRect.bottom).toBeGreaterThanOrEqual(120);

    const scroller = selectors.transcriptScroll(app.page);
    const before = await scroller.evaluate((node) => node.scrollTop);
    const scrollPoint = {
      x: transcriptRect.left + transcriptRect.width / 2,
      y: topChromeRect.bottom + (dockRect.top - topChromeRect.bottom) / 2,
    };
    const hitInTranscript = await scroller.evaluate(
      (node, point) => node.contains(document.elementFromPoint(point.x, point.y)),
      scrollPoint,
    );
    expect(hitInTranscript).toBe(true);
    const wheelMoved = scroller.evaluate(
      (node, start) =>
        new Promise<number>((resolve) => {
          const onScroll = () => {
            if (node.scrollTop > start) {
              node.removeEventListener('scroll', onScroll);
              resolve(node.scrollTop);
            }
          };
          node.addEventListener('scroll', onScroll);
          setTimeout(() => {
            node.removeEventListener('scroll', onScroll);
            resolve(node.scrollTop);
          }, 3000);
        }),
      before,
    );
    await app.page.mouse.move(scrollPoint.x, scrollPoint.y);
    await app.page.mouse.wheel(0, -320);
    expect(await wheelMoved).toBeGreaterThan(before);
  });
});
