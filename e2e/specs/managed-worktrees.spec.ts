import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { test, expect } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import { readRect } from '../layout/geometry.ts';

const execute = promisify(execFile);

test('automatically creates a worktree on send from the selected branch', async ({ app }) => {
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
  await execute('git', ['-C', cwd, 'branch', 'feature/source']);
  await page.goto(new URL('/profiles/harness-profile/chats/new', page.url()).href);
  await expect(selectors.newChatWorkspace(page)).toBeVisible();
  await expect(selectors.newChatLocal(page)).toBeChecked();
  await selectors.newChatWorktree(page).click();
  await expect(selectors.newChatWorktree(page)).toBeChecked();
  await selectors.newChatBranch(page).click();
  await selectors.branchOption(page, 'feature/source').click();
  await expect(selectors.newChatBranch(page)).toContainText('feature/source');
  const branch = await readRect(selectors.newChatBranch(page));
  const local = await readRect(selectors.newChatLocal(page));
  const isolated = await readRect(selectors.newChatWorktree(page));
  const viewport = page.viewportSize()!;
  for (const rect of [branch, local, isolated]) {
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(viewport.width);
  }
  expect(branch.top).toBeGreaterThanOrEqual(local.bottom);
  expect(isolated.left).toBeGreaterThanOrEqual(local.right);
  expect(await bridge.request('bridge/worktrees/list', {})).toEqual({ worktrees: [] });
  await selectors.composerInput(page).fill('Work in the isolated checkout');
  await selectors.composerSend(page).click();
  await expect(page).not.toHaveURL(/\/chats\/new$/);
  await expect
    .poll(
      async () =>
        ((await bridge.request('bridge/worktrees/list', {})) as { worktrees: unknown[] }).worktrees
          .length,
    )
    .toBe(1);
  const listed = (await bridge.request('bridge/worktrees/list', {})) as {
    worktrees: { path: string; status: string; baseRef: string }[];
  };
  expect(listed.worktrees).toHaveLength(1);
  expect(listed.worktrees[0]?.status).toBe('ready');
  expect(listed.worktrees[0]?.baseRef).toBe('feature/source');
  await expect
    .poll(async () => {
      const chats = (await bridge.request('thread/list', { limit: 100 })) as {
        data: { cwd: string }[];
      };
      return chats.data.some((chat) => chat.cwd === listed.worktrees[0]?.path);
    })
    .toBe(true);
  expect((await execute('git', ['-C', cwd, 'branch', '--show-current'])).stdout.trim()).toBe(
    'main',
  );
});
