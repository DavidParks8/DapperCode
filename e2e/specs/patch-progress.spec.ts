import { expect, type Locator } from '@playwright/test';

import { selectors } from '../fixtures/selectors.ts';
import { test, type AppHandle } from '../fixtures/test.ts';
import { E2E_THREADS } from '../harness/scenario.ts';
import {
  expectContainedWithin,
  expectNoOverlap,
  expectStackedVertically,
  expectVisible,
  expectWithinViewport,
} from '../layout/assertions.ts';

const FIRST_PATH = 'src/settings.ts';
const LONG_PATH =
  'apps/mobile/src/features/chat/message/components/patch-progress/extremely-long-directory-name/GeneratedPatchProgressStatusPresentation.tsx';
const INITIAL_TEXT = 'export const enabled = false;\n';
const FIRST_REVISION = 'export const enabled = true;\n';
const SECOND_REVISION = 'export const enabled = true;\nexport const retries = 3;\n';
const FINAL_REVISION = `${SECOND_REVISION}export const ready = true;\n`;
const FIRST_COUNTS = { path: FIRST_PATH, added: 1, removed: 1 };
const SECOND_COUNTS = [
  { path: FIRST_PATH, added: 2, removed: 1 },
  { path: LONG_PATH, added: 2, removed: 0 },
] as const;
const FINAL_COUNTS = [{ path: FIRST_PATH, added: 3, removed: 1 }, SECOND_COUNTS[1]] as const;

interface FileCounts {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

test.describe('live per-file patch progress', () => {
  test('updates collapsed rows in place and preserves settled counts after reload', async ({
    createApp,
  }, testInfo) => {
    const app = await createApp({ chatId: E2E_THREADS.short });
    const toolCallId = 'live-apply-patch';

    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.short,
      chunks: [],
      toolSteps: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'apply_patch',
            kind: 'other',
            status: 'pending',
          },
          whilePaused: async () => {
            await expectHeader(app, /^Waiting to edit\b/);
            await expect(selectors.toolPatchFile(app.page)).toHaveCount(0);
            await expect(selectors.toolOutput(app.page)).toHaveCount(0);
            await expect(selectors.toolShimmer(app.page)).toHaveCount(0);
            await expectVisible(selectors.composerStopSlot(app.page));
          },
        },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            content: [diff(FIRST_PATH, INITIAL_TEXT, FIRST_REVISION)],
          },
          whilePaused: async () => {
            await expectHeader(app, /^Editing\b/);
            await expectFiles(app, [FIRST_COUNTS]);
            await expectVisible(selectors.toolShimmer(app.page));
            await expectVisible(selectors.composerStopSlot(app.page));
          },
        },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            content: [diff(FIRST_PATH, INITIAL_TEXT, SECOND_REVISION)],
          },
          whilePaused: async () => {
            await expectHeader(app, /^Editing\b/);
            await expectFiles(app, [SECOND_COUNTS[0]]);
          },
        },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            content: [
              diff(LONG_PATH, null, 'export const label = "Patch";\nexport default label;\n'),
            ],
          },
          whilePaused: async () => {
            await expectHeader(app, /^Editing 2 files \+4 -1$/);
            await expectFiles(app, SECOND_COUNTS);
            await expectVisible(selectors.toolShimmer(app.page));
          },
        },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            content: [diff(FIRST_PATH, INITIAL_TEXT, FINAL_REVISION)],
          },
          whilePaused: async () => {
            await expectHeader(app, /^Editing 2 files \+5 -1$/);
            await expectFiles(app, FINAL_COUNTS);
            await app.page.screenshot({ path: testInfo.outputPath('patch-running.png') });
          },
        },
        {
          update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
          whilePaused: async () => {
            // This update carries no content: the cumulative patch must remain intact.
            await expectHeader(app, /^Edited 2 files \+5 -1$/);
            await expectFiles(app, FINAL_COUNTS);
            await expect(selectors.toolShimmer(app.page)).toHaveCount(0);
            await expectVisible(selectors.composerStopSlot(app.page));
          },
        },
      ],
    });

    await expectHeader(app, /^Edited 2 files \+5 -1$/);
    await expectFiles(app, FINAL_COUNTS);
    await expectSettledComposer(app);
    await app.page.screenshot({ path: testInfo.outputPath('patch-settled.png') });

    // A new client reads the real bridge snapshot; no history is reseeded or replaced.
    await app.page.reload({ waitUntil: 'domcontentloaded' });
    await expectHeader(app, /^Edited 2 files \+5 -1$/);
    await expectFiles(app, FINAL_COUNTS);
    await expectSettledComposer(app);

    await selectors.toolTitleToggle(app.page).click();
    await expectVisible(selectors.toolOutput(app.page));
    await expect(selectors.toolPatchFile(app.page)).toHaveCount(2);
    await selectors.toolTitleToggle(app.page).click();
    await expectFiles(app, FINAL_COUNTS);
  });

  test('retains partial file counts and unavailable counts after a failed edit', async ({
    createApp,
  }, testInfo) => {
    const app = await createApp({ chatId: E2E_THREADS.short });
    const toolCallId = 'failed-patch';
    const deletedPath = 'src/obsolete.ts';
    const largePath = 'src/generated.ts';
    const missingPath = 'config/settings.bin';
    const paths = [deletedPath, largePath, missingPath];
    const expectFailureFiles = async () => {
      await expectCollapsedFiles(app, paths);
      await expectCounts(selectors.toolPatchFile(app.page).nth(0), {
        path: deletedPath,
        added: 0,
        removed: 1,
      });
      for (const index of [1, 2]) {
        const row = selectors.toolPatchFile(app.page).nth(index);
        await expect(selectors.toolPatchStats(row)).toHaveText(/counts? unavailable/i);
        await expect(selectors.toolPatchStats(row)).not.toHaveText(/\+0|-0/);
        expect(await row.getAttribute('aria-label')).toContain(paths[index]);
        expect(await row.getAttribute('aria-label')).toMatch(/counts? unavailable/i);
      }
    };

    await app.bridge.streamAssistantTurn({
      threadId: E2E_THREADS.short,
      chunks: [],
      succeed: false,
      toolSteps: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Edit tracked files',
            kind: 'edit',
            status: 'in_progress',
            content: [
              diff(deletedPath, 'obsolete();\n', ''),
              // More than a million LCS cells, but below the bridge's structured-string limit.
              diff(largePath, 'old\n'.repeat(1001), 'new\n'.repeat(1001)),
            ],
            locations: paths.map((path) => ({ path })),
          },
          whilePaused: async () => {
            await expectHeader(app, /^Editing\b/);
            await expectFailureFiles();
            await expectVisible(selectors.toolShimmer(app.page));
            await expectVisible(selectors.composerStopSlot(app.page));
            await app.page.screenshot({ path: testInfo.outputPath('patch-before-failure.png') });
          },
        },
        {
          update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' },
          whilePaused: async () => {
            await expectHeader(app, /^Failed to edit\b/);
            await expectFailureFiles();
            await expect(selectors.toolShimmer(app.page)).toHaveCount(0);
          },
        },
      ],
    });

    await expectHeader(app, /^Failed to edit\b/);
    await expectFailureFiles();
    await expectSettledComposer(app);
    await app.page.screenshot({ path: testInfo.outputPath('patch-failed.png') });
  });
});

function diff(path: string, oldText: string | null, newText: string) {
  return { type: 'diff' as const, path, oldText, newText };
}

async function expectHeader(app: AppHandle, title: RegExp): Promise<void> {
  await expect(selectors.toolHeader(app.page)).toHaveCount(1);
  await expect(selectors.toolHeader(app.page)).toHaveAccessibleName(title);
}

async function expectCounts(row: Locator, counts: FileCounts): Promise<void> {
  await expect(selectors.toolPatchStats(row)).toHaveText(
    new RegExp(`^\\+${String(counts.added)}\\s*-${String(counts.removed)}$`, 'u'),
  );
  await expect(row).toHaveAttribute(
    'aria-label',
    `${counts.path}, ${String(counts.added)} ${counts.added === 1 ? 'line' : 'lines'} added, ` +
      `${String(counts.removed)} ${counts.removed === 1 ? 'line' : 'lines'} removed`,
  );
}

async function expectFiles(app: AppHandle, files: readonly FileCounts[]): Promise<void> {
  await expectCollapsedFiles(
    app,
    files.map((file) => file.path),
  );
  for (const [index, counts] of files.entries()) {
    await expectCounts(selectors.toolPatchFile(app.page).nth(index), counts);
  }
}

async function expectCollapsedFiles(app: AppHandle, paths: readonly string[]): Promise<void> {
  const header = selectors.toolHeader(app.page);
  const files = selectors.toolPatchFiles(app.page);
  const rows = selectors.toolPatchFile(app.page);
  await expect(selectors.toolOutput(app.page)).toHaveCount(0);
  await expect(rows).toHaveCount(paths.length);
  await expect(selectors.toolPatchName(app.page)).toHaveText(
    paths.map((path) => path.split('/').pop() ?? path),
  );
  await expect(selectors.toolPatchPath(app.page)).toHaveText([...paths]);
  await expectVisible(files);
  await expectStackedVertically([header, files]);
  await expectContainedWithin(files, selectors.transcript(app.page));
  await expectWithinViewport(files);
  await expectNoOverlap(files, selectors.composer(app.page));
  if (paths.length > 1) await expectStackedVertically(rows);
  for (let index = 0; index < paths.length; index += 1) {
    const row = rows.nth(index);
    const path = selectors.toolPatchPath(row);
    const name = selectors.toolPatchName(row);
    const stats = selectors.toolPatchStats(row);
    await expectVisible(row);
    await expectContainedWithin(row, files);
    await expectContainedWithin(path, row);
    await expectContainedWithin(name, row);
    await expectContainedWithin(stats, row);
    await expectNoOverlap(path, stats);
    await expectNoOverlap(name, stats);
  }
}

async function expectSettledComposer(app: AppHandle): Promise<void> {
  await expect(selectors.toolShimmer(app.page)).toHaveCount(0);
  await expect(selectors.composerStopSlot(app.page)).toHaveCount(0);
  await expectVisible(selectors.composerSubmitSlot(app.page));
  await expect(selectors.composerInput(app.page)).toBeEditable();
  await selectors.composerInput(app.page).fill('Ready for the next change');
  await expect(selectors.composerInput(app.page)).toHaveValue('Ready for the next change');
  await selectors.composerInput(app.page).fill('');
}
