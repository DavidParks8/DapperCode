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

  test('phone-call approval, live stage whisper, split pane, and inline post-call record preserve scrolling', async ({
    createApp,
  }) => {
    const threadId = scenarioThreadId('phone-call-scroll');
    const reportText = [
      '[Outbound phone call ended]',
      'Call ID: call-1',
      'To: CVS Pharmacy (+15551234567)',
      'Status: completed',
      'Duration: 3:15 (195s)',
      'End reason: remote_bye',
      'Outcome summary: Prescription refill ready Friday at 2 PM.',
      'Objective: Confirm prescription pickup window.',
      '',
      'Transcript:',
      'Agent: Hello, checking on a prescription refill.',
      'Event: Pressed 2',
      'Tool: Calendar lookup · completed: Free after 2 PM',
      'CVS Pharmacy: Ready Friday at 2 PM.',
    ].join('\n');
    const messages = [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `call-msg-${String(index + 1)}`,
        role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text:
          index % 2 === 0
            ? `Call check ${String(index + 1)}`
            : `Call response ${String(index + 1)}: confirming the transcript remains readable and scrollable when call surfaces arrive.`,
      })),
      {
        id: 'call-report-1',
        role: 'user' as const,
        text: reportText,
      },
    ];
    const app = await createApp({
      chatId: threadId,
      scenario: {
        chats: [{ id: 'phone-call-scroll', title: 'Phone call scrolling', messages }],
      },
    });

    // Settled call already recorded in the transcript renders as a collapsible inline Call Record
    // and never lingers as a docked pill above the composer.
    await app.bridge.request('bridge/ui/present', {
      id: 'phone-call-live:call-1',
      threadId,
      kind: 'phone-call',
      presentation: 'workflowCard',
      tone: 'neutral',
      title: 'Phone call ended',
      subtitle: 'Duration 3:15',
      blocks: [
        {
          type: 'keyValue',
          items: [
            { label: 'Status', value: 'Ended' },
            { label: 'To', value: 'CVS Pharmacy (+15551234567)' },
            { label: 'Duration', value: '3:15' },
          ],
        },
      ],
      actions: [],
      dismissible: true,
      createdAt: '2026-11-26T18:01:00.000Z',
    });

    await expect(selectors.phoneCallDock(app.page)).toHaveCount(0);
    const recordCard = selectors.phoneCallRecordCard(app.page);
    await expectVisible(recordCard);
    await selectors.phoneCallRecordToggle(app.page).click();
    await expectVisible(selectors.phoneCallRecordTimeline(app.page));
    await selectors.phoneCallRecordToggle(app.page).click();

    // Pre-call approval sheet formats the number and lets the user edit before approving.
    await app.bridge.request('bridge/ui/present', {
      id: 'phone-call-approval:call-2',
      threadId,
      kind: 'phone-call',
      presentation: 'modal',
      tone: 'warning',
      title: 'Approve outbound phone call',
      subtitle: 'CVS Pharmacy (+15551234567)',
      blocks: [
        {
          type: 'keyValue',
          items: [
            { label: 'To', value: 'CVS Pharmacy (+15551234567)' },
            { label: 'From', value: '+15550000001' },
            { label: 'On behalf of', value: 'David' },
            { label: 'Objective', value: 'Ask when pickup is ready.' },
          ],
        },
      ],
      actions: [
        { id: 'approve', label: 'Approve & Call', style: 'primary', dismissesSurface: true },
        { id: 'cancel', label: 'Cancel', style: 'destructive', dismissesSurface: true },
      ],
      dismissible: false,
    });
    await expectVisible(selectors.phoneCallApprovalSheet(app.page));
    await selectors.phoneCallApprovalEdit(app.page).click();
    await selectors.phoneCallApprovalObjectiveInput(app.page).fill('Confirm Friday 2 PM pickup.');
    await selectors.phoneCallApprovalApprove(app.page).click();
    await expect(selectors.phoneCallApprovalSheet(app.page)).toHaveCount(0);

    // Active live call sits as a 1-row ambient pill and opens the Live Call Stage on tap.
    await app.bridge.request('bridge/ui/present', {
      id: 'phone-call-live:call-2',
      threadId,
      kind: 'phone-call',
      presentation: 'workflowCard',
      tone: 'success',
      title: 'Phone call · CVS Pharmacy',
      subtitle: 'In call',
      blocks: [
        {
          type: 'keyValue',
          items: [
            { label: 'Status', value: 'In call' },
            { label: 'To', value: 'CVS Pharmacy (+15551234567)' },
            { label: 'From', value: '+15550000001' },
            { label: 'Activity', value: 'Checking calendar…' },
            { label: 'Duration', value: '0:24' },
            { label: 'Objective', value: 'Confirm Friday 2 PM pickup.' },
          ],
        },
        {
          type: 'markdown',
          markdown:
            '**Live transcript**\n\n**Agent:** Checking on pickup.\n\n**Tool:** Checking calendar… · running\n\n**CVS Pharmacy:** One moment please.',
        },
      ],
      actions: [{ id: 'hangup', label: 'Hang Up', style: 'destructive', dismissesSurface: false }],
      dismissible: false,
      createdAt: '2026-11-26T18:05:00.000Z',
    });

    const dock = selectors.phoneCallDock(app.page);
    await expect(dock).toHaveCount(1);
    await expect(selectors.topCards(app.page)).toHaveCount(0);
    await app.settle();

    // Opening the Live Call Stage reveals the two-sided transcript + whisper bar.
    await selectors.phoneCallDockToggle(app.page).click();
    await expectVisible(selectors.phoneCallStage(app.page));
    await expectVisible(selectors.phoneCallWhisperInput(app.page));

    // On a wide Open-Duo / tablet landscape viewport (1180×760 with docked sidebar -> 868px scene),
    // the open Live Call Stage transitions live from sheet to a trailing side pane beside the chat.
    const originalViewport = app.page.viewportSize();
    if (test.info().project.name === 'tablet') {
      await app.page.setViewportSize({ width: 1180, height: 760 });
      await app.settle();
      await expectVisible(selectors.phoneCallStageSplitPane(app.page));
      const [paneRect, transcriptSplitRect] = await Promise.all([
        readRect(selectors.phoneCallStageSplitPane(app.page)),
        readRect(selectors.transcript(app.page)),
      ]);
      expect(paneRect.left).toBeGreaterThanOrEqual(transcriptSplitRect.right - 2);
      if (originalViewport) {
        await app.page.setViewportSize(originalViewport);
      }
      await app.settle();
    }

    // Close the stage back to the 1-row pill and verify unobstructed transcript scrolling.
    await selectors.phoneCallStageClose(app.page).click();
    await expect(selectors.phoneCallStage(app.page)).toHaveCount(0);
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
