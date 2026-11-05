import fs from 'node:fs/promises';
import path from 'node:path';
import productScenario from './native-product.mjs';
import { nativeOnDeviceSelectors as s } from '../../../../../e2e/fixtures/selectors.ts';

export const name = 'on-device-local-siblings';
export const contract = {
  requiredPhases: [
    'bundle',
    'prepare',
    'onboard',
    'settings',
    'model-download',
    'model-sheet',
    'sibling-chat-fixtures',
    'sibling-git-discard',
    'sibling-chat-history',
    'sibling-clone-stop',
  ],
};

export default async function scenario(e2e, { cloneOnly = false, singleModelFamily = false } = {}) {
  return productScenario(e2e, {
    singleModelFamily,
    autoAcceptAlerts: false,
    afterModelSheet: async (ctx) => {
      const {
        api,
        query,
        find,
        tap,
        reveal,
        absent,
        capture,
        type,
        loadThreads,
        startNewChat,
        openChat,
        openDrawer,
        repository,
        git,
        hold,
        swipeLeft,
        publicOrigin,
        publicGit,
        container,
        readJSON,
        source,
      } = ctx;
      const runGit = (args) => git(['-C', repository, ...args]);
      const read = (file) => fs.readFile(path.join(repository, file), 'utf8');
      const put = async (file, content) => {
        const fixture = e2e.writeFile(`data/${file}`, content);
        await e2e.run('cp', [fixture, path.join(repository, file)]);
      };
      const clear = async (selector) => api(`/element/${await find(selector, true)}/clear`, {});
      const idle = async () => {
        await e2e.waitFor(
          'local chat controls settle',
          async () => (await absent(s.stop)) && (await absent(s.stopping)),
          { timeoutMs: 30_000 },
        );
        await e2e.check('the settled composer remains editable', async () =>
          api(`/element/${await find(s.message, true)}/enabled`, undefined, 'GET'),
        );
      };
      const newReadChat = async (marker) => {
        const known = new Set((await loadThreads()).map((entry) => entry.id));
        await startNewChat();
        await type(
          s.message,
          `Use read_file to read seed.txt. Then reply with ${marker}. Do not change files.`,
        );
        await tap(s.send);
        let chat;
        await e2e.waitFor(
          'the real local history fixture completes',
          async () => {
            chat = (await loadThreads()).find((entry) => !known.has(entry.id));
            return chat && ['complete', 'failed', 'interrupted'].includes(chat.status);
          },
          { timeoutMs: 300_000, intervalMs: 1000 },
        );
        await e2e.expectEqual('history fixture turn is complete', chat.status, 'complete');
        const result = chat.messages.find(
          (entry) => entry.tool?.name === 'read_file' && entry.tool.status === 'completed',
        );
        await e2e.expectEqual(
          'history fixture consumed real workspace bytes',
          result ? JSON.parse(result.content).content : null,
          'fixture\n',
        );
        await idle();
        return chat;
      };
      let a;
      let b;
      if (!cloneOnly) {
        await e2e.phase('sibling-chat-fixtures', async () => {
          a = await newReadChat('LOCAL_SIBLING_A');
          b = await newReadChat('LOCAL_SIBLING_B');
          await e2e.check('two distinct real histories exist', () => a.id !== b.id);
        });

        await e2e.phase('sibling-git-discard', async () => {
          await e2e.expectEqual(
            'discard fixtures start in a clean owned repository',
            (await runGit(['status', '--porcelain'])).stdout,
            '',
          );
          await put('discard-tracked.txt', 'committed baseline\n');
          await put('discard-staged.txt', 'original staged file\n');
          await runGit(['add', '--', 'discard-tracked.txt', 'discard-staged.txt']);
          await runGit([
            '-c',
            'user.name=Native QA',
            '-c',
            'user.email=native-qa@example.invalid',
            '-c',
            'core.hooksPath=/dev/null',
            'commit',
            '--no-gpg-sign',
            '-m',
            'seed discard fixture',
          ]);
          await put('discard-tracked.txt', 'unstaged changes\n');
          await put('discard-staged.txt', 'staged bytes survive\n');
          await runGit(['add', '--', 'discard-staged.txt']);
          await put('discard-untracked.txt', 'untracked bytes\n');
          const before = (await runGit(['status', '--porcelain'])).stdout;
          const unchanged = async () => {
            await e2e.expectEqual(
              'tracked bytes survive a noncommitting discard gesture',
              await read('discard-tracked.txt'),
              'unstaged changes\n',
            );
            await e2e.expectEqual(
              'untracked bytes survive a noncommitting discard gesture',
              await read('discard-untracked.txt'),
              'untracked bytes\n',
            );
            await e2e.expectEqual(
              'the index and complete status stay unchanged',
              (await runGit(['status', '--porcelain'])).stdout,
              before,
            );
          };
          await tap(s.openGit);
          await tap(s.gitRefresh);
          await find(s.gitDiscardAll);
          await reveal(s.gitDiscardAll);
          await tap(s.gitDiscardAll);
          await unchanged();
          await hold(s.gitDiscardAll, 0.4);
          await unchanged();
          await hold(s.gitDiscardAll, 1.6);
          await e2e.waitFor(
            'the deliberate hold restores only unstaged changes',
            async () =>
              (await runGit(['status', '--porcelain'])).stdout === 'M  discard-staged.txt\n',
            { timeoutMs: 30_000 },
          );
          await e2e.expectEqual(
            'discard restores tracked bytes from the index',
            await read('discard-tracked.txt'),
            'committed baseline\n',
          );
          await e2e.expectEqual(
            'staged worktree bytes remain',
            await read('discard-staged.txt'),
            'staged bytes survive\n',
          );
          await e2e.expectEqual(
            'staged index bytes remain',
            (await runGit(['show', ':discard-staged.txt'])).stdout,
            'staged bytes survive\n',
          );
          await e2e.run('test', ['!', '-e', path.join(repository, 'discard-untracked.txt')]);
          await e2e.check(
            'discard spinner and all-unstaged action settle',
            async () => (await absent(s.gitDiscarding)) && (await absent(s.gitDiscardAll)),
          );
          await put('discard-tracked.txt', 'per-file unstaged changes\n');
          await tap(s.gitRefresh);
          await reveal(s.gitFile('discard-tracked.txt'));
          await swipeLeft(s.gitFile('discard-tracked.txt'));
          await e2e.waitFor(
            'the file swipe restores bytes or exposes its deliberate discard action',
            async () =>
              (await read('discard-tracked.txt')) === 'committed baseline\n' ||
              (await query(s.gitDiscardFile('discard-tracked.txt'), true)).length > 0,
            { timeoutMs: 15_000 },
          );
          if ((await read('discard-tracked.txt')) !== 'committed baseline\n') {
            await tap(s.gitDiscardFile('discard-tracked.txt'));
          }
          await e2e.waitFor(
            'per-file discard restores the tracked baseline',
            async () => (await read('discard-tracked.txt')) === 'committed baseline\n',
            { timeoutMs: 30_000 },
          );
          await e2e.expectEqual(
            'per-file discard also preserves the separate staged change',
            (await runGit(['diff', '--cached', '--name-only'])).stdout,
            'discard-staged.txt\n',
          );
          await capture('siblings-git-discard');
          await tap(s.gitBack);
          await idle();
        });

        await e2e.phase('sibling-chat-history', async () => {
          const messagesA = structuredClone(a.messages);
          const messagesB = structuredClone(b.messages);
          const history = async (id) => (await loadThreads()).find((entry) => entry.id === id);
          await openChat(a.id);
          await tap(s.editSessionTitle);
          await clear(s.sessionTitle);
          await type(s.sessionTitle, 'Cancelled rename');
          await tap(s.cancelRename);
          await e2e.expectEqual(
            'cancelling rename keeps the persisted title',
            (await history(a.id)).title,
            a.title,
          );
          await tap(s.editSessionTitle);
          await clear(s.sessionTitle);
          await type(s.sessionTitle, 'Native sibling renamed');
          await tap(s.saveSessionTitle);
          await e2e.waitFor(
            'manual rename persists',
            async () => (await history(a.id)).title === 'Native sibling renamed',
            { timeoutMs: 30_000 },
          );
          a.title = 'Native sibling renamed';
          await openChat(b.id);
          await openChat(a.id);
          await e2e.expectEqual(
            'renaming and navigating preserves the first transcript',
            (await history(a.id)).messages,
            messagesA,
          );
          await e2e.expectEqual(
            'another transcript is unaffected',
            (await history(b.id)).messages,
            messagesB,
          );
          const requestDelete = async () => {
            await openDrawer();
            await swipeLeft(`${s.chatRowPrefix}${a.id}`);
            await e2e.waitFor(
              'swiping opens a delete confirmation or its row action',
              async () =>
                (await query(s.deleteSessionDialog, true)).length > 0 ||
                (await query(s.deleteChat(a.title), true)).length > 0,
              { timeoutMs: 15_000 },
            );
            if ((await query(s.deleteSessionDialog, true)).length === 0) {
              await tap(s.deleteChat(a.title));
            }
            await find(s.deleteSessionDialog, true);
          };
          await requestDelete();
          await tap(s.deleteSessionCancel);
          await e2e.expectEqual(
            'cancelled deletion keeps complete history',
            (await history(a.id)).messages,
            messagesA,
          );
          await tap(`${s.chatRowPrefix}${a.id}`);
          await idle();
          await requestDelete();
          await tap(s.deleteSessionConfirm);
          await e2e.waitFor(
            'confirmed deletion removes persisted history',
            async () => !(await history(a.id)),
            { timeoutMs: 30_000 },
          );
          await e2e.waitFor(
            'the surviving session list settles after deleted-chat navigation',
            async () => (await query(`${s.chatRowPrefix}${b.id}`, true)).length > 0,
            { timeoutMs: 15_000 },
          );
          await e2e.check(
            'only the confirmed history disappears from the drawer',
            async () =>
              (await absent(`${s.chatRowPrefix}${a.id}`)) &&
              (await query(`${s.chatRowPrefix}${b.id}`, true)).length > 0,
          );
          await openChat(b.id);
          await e2e.expectEqual(
            'the surviving history stays exact',
            (await history(b.id)).messages,
            messagesB,
          );
          await idle();
          await capture('siblings-chat-history');
        });
      }

      await e2e.phase('sibling-clone-stop', async () => {
        const preferences = path.join(
          container,
          'Library/Application Support/OnDeviceAgent/state/preferences.json',
        );
        const originalWorkspace = (await readJSON(preferences)).workspaceId;
        await startNewChat();
        await tap(s.workspace);
        await tap(s.cloneRepository);
        await type(s.cloneUrl, 'git@github.com:acme/tool.git');
        await e2e.check(
          'SSH input cannot start a managed clone',
          async () =>
            !(await api(
              `/element/${await find(s.cloneRepository, true)}/enabled`,
              undefined,
              'GET',
            )) && (await query(s.checkoutUrlError)).length > 0,
        );
        await tap(s.cancelCheckout);
        await tap(s.workspaceDone);
        await e2e.expectEqual(
          'cancelling an untouched clone form keeps the selected workspace',
          (await readJSON(preferences)).workspaceId,
          originalWorkspace,
        );
        await tap(s.workspace);
        await tap(s.cloneRepository);
        await type(s.cloneUrl, publicOrigin);
        await e2e.check(
          'the paused remote is a tracked run-owned process',
          () => Number.isInteger(publicGit.pid) && publicGit.isRunning(),
        );
        await e2e.run('kill', ['-STOP', String(publicGit.pid)]);
        try {
          await tap(s.cloneRepository);
          await find(s.stopCloning, true);
          await e2e.check(
            'a pending real native transfer locks clone submission',
            async () =>
              !(await api(
                `/element/${await find(s.cloneRepository, true)}/enabled`,
                undefined,
                'GET',
              )),
          );
          await tap(s.stopCloning);
          await e2e.waitFor(
            'Stop is acknowledged as cancellation in progress',
            async () =>
              (await query(s.checkoutStopping, true)).length > 0 ||
              (await query(s.cancelCheckout, true)).length > 0,
            { timeoutMs: 30_000 },
          );
        } finally {
          await e2e.run('kill', ['-CONT', String(publicGit.pid)]);
        }
        await e2e.waitFor(
          'the cancelled clone settles and restores its form',
          async () =>
            (await query(s.cancelCheckout, true)).length > 0 && (await absent(s.stopCloning)),
          { timeoutMs: 60_000 },
        );
        await e2e.expectEqual(
          'cancelled native clone never selects a partial workspace',
          (await readJSON(preferences)).workspaceId,
          originalWorkspace,
        );
        await e2e.expectMatch(
          'the cancellation is explicit rather than success-shaped',
          await source(),
          /cancelled|canceled/iu,
        );
        await tap(s.cloneRepository);
        await e2e.waitFor(
          'retry against the resumed real remote selects its workspace',
          async () =>
            (await readJSON(preferences)).workspaceId !== originalWorkspace &&
            (await query(s.workspace, true)).length > 0,
          { timeoutMs: 90_000 },
        );
        const clonedId = (await readJSON(preferences)).workspaceId;
        const clonedRepo = path.join(
          path.dirname(path.dirname(repository)),
          clonedId,
          'repository',
        );
        await e2e.expectEqual(
          'the retry contains actual remote file bytes',
          await fs.readFile(path.join(clonedRepo, 'README.md'), 'utf8'),
          'PUBLIC_CLONE_OK\n',
        );
        await capture('siblings-clone-recovered');
      });
    },
  });
}
