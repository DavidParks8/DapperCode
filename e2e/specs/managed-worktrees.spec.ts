import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { test, expect } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import { readRect } from '../layout/geometry.ts';

const execute = promisify(execFile);

test('creates and selects a managed checkout with usable phone and tablet controls', async ({
  app,
}) => {
  const { bridge, page } = app;
  const roots = (await bridge.request('bridge/workspaces/list', {})) as { bridgeRoot: string };
  const cwd = roots.bridgeRoot;
  await execute('git', ['-C', cwd, 'init', '-b', 'main']);
  await writeFile(path.join(cwd, 'README.md'), '# Worktree layout test\n');
  await execute('git', ['-C', cwd, 'add', '.']);
  await execute('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'Initial',
  ]);
  await page.goto(
    new URL(
      `/profiles/harness-profile/chats/new/worktrees?cwd=${encodeURIComponent(cwd)}`,
      page.url(),
    ).href,
  );
  await expect(selectors.worktreesScreen(page)).toBeVisible();
  await expect(selectors.worktreeBranch(page)).toBeEditable();
  await expect(selectors.worktreeCreate(page)).toBeDisabled();
  await selectors.worktreeBranch(page).fill('feature/mobile-task');
  await selectors.worktreeBase(page).fill('main');
  const branch = await readRect(selectors.worktreeBranch(page));
  const base = await readRect(selectors.worktreeBase(page));
  const create = await readRect(selectors.worktreeCreate(page));
  const viewport = page.viewportSize()!;
  for (const rect of [branch, base, create]) {
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(viewport.width);
  }
  expect(base.top).toBeGreaterThanOrEqual(branch.bottom);
  expect(create.top).toBeGreaterThanOrEqual(base.bottom);
  await selectors.worktreeCreate(page).click();
  await expect(selectors.worktreeUse(page, 'feature/mobile-task')).toBeEnabled();
  const listed = (await bridge.request('bridge/worktrees/list', {})) as {
    worktrees: { path: string; status: string }[];
  };
  expect(listed.worktrees).toHaveLength(1);
  expect(listed.worktrees[0]?.status).toBe('ready');
  await selectors.worktreeUse(page, 'feature/mobile-task').click();
  await expect(page).toHaveURL(/\/chats\/new$/);
  await expect(selectors.composerInput(page)).toBeVisible();
  // Selection is also verified by the real chat's cwd after the user submits below.
  await selectors.composerInput(page).fill('Work in the isolated checkout');
  await selectors.composerSend(page).click();
  await expect(page).not.toHaveURL(/\/chats\/new$/);
  const chats = (await bridge.request('thread/list', { limit: 100 })) as {
    data: { cwd: string }[];
  };
  expect(chats.data.some((chat) => chat.cwd === listed.worktrees[0]?.path)).toBe(true);
});
