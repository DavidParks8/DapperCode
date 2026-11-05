import fs from 'node:fs/promises';
import path from 'node:path';
import productScenario from './native-product.mjs';
import { nativeOnDeviceSelectors as s } from '../../../../../e2e/fixtures/selectors.ts';

export const name = 'on-device-local-edge-flows';
export const contract = {
  requiredPhases: [
    'bundle',
    'prepare',
    'onboard',
    'settings',
    'model-download',
    'model-sheet',
    'edge-chat-baseline',
    'edge-nested-files-and-conflicts',
    'edge-stop-pending-approval',
    'edge-unsupported-execution',
  ],
};

export default async function scenario(e2e, { sharedWorkflowOnly = false } = {}) {
  return productScenario(e2e, {
    singleModelFamily: sharedWorkflowOnly,
    autoAcceptAlerts: false,
    afterModelSheet: async (ctx) => {
      const {
        api,
        query,
        find,
        tap,
        absent,
        capture,
        type,
        loadThreads,
        startNewChat,
        repository,
        container,
        source,
      } = ctx;
      const read = (file) => fs.readFile(path.join(repository, file), 'utf8');
      const put = async (file, content) => {
        const fixture = e2e.writeFile(`data/${file}`, content);
        await e2e.run('cp', [fixture, path.join(repository, file)]);
      };
      const clear = async (selector) => api(`/element/${await find(selector, true)}/clear`, {});
      const value = async () =>
        api(`/element/${await find(s.filesEditor, true)}/attribute/value`, undefined, 'GET');
      const settled = async () => {
        await e2e.waitFor(
          'local turn releases every running control',
          async () => (await absent(s.stop)) && (await absent(s.stopping)),
          { timeoutMs: 30_000 },
        );
        await e2e.check('the settled composer remains editable', async () =>
          api(`/element/${await find(s.message, true)}/enabled`, undefined, 'GET'),
        );
      };
      const send = async (prompt, id) => {
        const before = await loadThreads();
        const known = new Set(before.map((entry) => entry.id));
        const count = before.find((entry) => entry.id === id)?.messages.length ?? 0;
        await type(s.message, prompt);
        await tap(s.send);
        let chat;
        await e2e.waitFor(
          'the native edge-flow conversation settles',
          async () => {
            chat = (await loadThreads()).find((entry) =>
              id ? entry.id === id : !known.has(entry.id),
            );
            return (
              chat &&
              chat.messages.length > count &&
              ['complete', 'failed', 'interrupted'].includes(chat.status)
            );
          },
          { timeoutMs: 900_000, intervalMs: 1000 },
        );
        await e2e.expectEqual('the local edge-flow turn completes', chat.status, 'complete');
        await settled();
        return chat;
      };
      await e2e.phase('edge-chat-baseline', async () => {
        const prompt = 'Read seed.txt using read_file. Do not change any files.';
        const chat = await send(prompt);
        await e2e.expectEqual(
          'the baseline user request has exactly one rendered bubble',
          (await query(s.userMessageText(prompt), true)).length,
          1,
        );
        await e2e.check('the baseline uses the real file tool', () =>
          chat.messages.some(
            (entry) => entry.tool?.name === 'read_file' && entry.tool.status === 'completed',
          ),
        );
        await e2e.expectEqual(
          'baseline leaves the real workspace unchanged',
          await read('seed.txt'),
          'fixture\n',
        );
      });
      await e2e.phase('edge-nested-files-and-conflicts', async () => {
        await e2e.run('mkdir', [path.join(repository, 'nested')]);
        await put('nested/fixture.txt', 'NESTED_FIXTURE\n');
        await tap(s.openGit);
        await tap(s.browseFiles);
        await tap(s.folderOpen('nested'));
        await tap(s.fileOpen('fixture.txt'));
        await e2e.expectEqual(
          'nested navigation reads the exact file',
          await value(),
          'NESTED_FIXTURE\n',
        );
        await tap(s.filesBack);
        await tap(s.filesNew);
        await type(s.filesCreateInput, '../outside.txt');
        await e2e.check(
          'file creation rejects paths in the name field',
          async () =>
            !(await api(
              `/element/${await find(s.filesCreateSubmit, true)}/enabled`,
              undefined,
              'GET',
            )),
        );
        await clear(s.filesCreateInput);
        await type(s.filesCreateInput, 'created.txt');
        await tap(s.filesCreateSubmit);
        await type(s.filesEditor, 'LOCAL_INITIAL');
        await tap(s.filesBack);
        await find(s.filesUnsaved, true);
        await tap(s.filesKeepEditing);
        await e2e.expectEqual(
          'Keep editing preserves the unsaved draft',
          await value(),
          'LOCAL_INITIAL',
        );
        await e2e.expectEqual(
          'Keep editing does not save implicitly',
          await read('nested/created.txt'),
          '',
        );
        await tap(s.filesBack);
        await tap(s.filesSaveBanner);
        await e2e.waitFor('banner save clears the dirty state', () => absent(s.filesDirty), {
          timeoutMs: 30_000,
        });
        await e2e.expectEqual(
          'banner save targets the nested folder',
          await read('nested/created.txt'),
          'LOCAL_INITIAL',
        );
        await clear(s.filesEditor);
        await type(s.filesEditor, 'DRAFT_TO_DISCARD');
        await put('nested/created.txt', 'EXTERNAL_VERSION_ONE');
        await tap(s.filesSave);
        await find(s.filesConflict, true);
        await e2e.expectEqual(
          'conflicting save never overwrites external bytes',
          await read('nested/created.txt'),
          'EXTERNAL_VERSION_ONE',
        );
        await e2e.expectEqual(
          'conflicting save keeps the complete local draft',
          await value(),
          'DRAFT_TO_DISCARD',
        );
        await tap(s.filesDiscardLatest);
        await e2e.waitFor(
          'discard adopts the newest native version',
          async () => (await absent(s.filesDirty)) && (await absent(s.filesConflict)),
          { timeoutMs: 30_000 },
        );
        await e2e.expectEqual(
          'discard reloads the external file',
          await value(),
          'EXTERNAL_VERSION_ONE',
        );
        await clear(s.filesEditor);
        await type(s.filesEditor, 'EXPLICIT_OVERWRITE');
        await put('nested/created.txt', 'EXTERNAL_VERSION_TWO');
        await tap(s.filesSave);
        await find(s.filesConflict, true);
        await e2e.expectEqual(
          'a second conflict still preserves external bytes',
          await read('nested/created.txt'),
          'EXTERNAL_VERSION_TWO',
        );
        await tap(s.filesOverwrite);
        await e2e.waitFor(
          'explicit overwrite settles every editor state',
          async () => (await absent(s.filesDirty)) && (await absent(s.filesConflict)),
          { timeoutMs: 30_000 },
        );
        await e2e.expectEqual(
          'Overwrite writes only the approved local draft',
          await read('nested/created.txt'),
          'EXPLICIT_OVERWRITE',
        );
        await e2e.check(
          'saved editor disables Save again',
          async () =>
            !(await api(`/element/${await find(s.filesSave, true)}/enabled`, undefined, 'GET')),
        );
        await e2e.expectEqual(
          'the adjacent nested fixture is untouched',
          await read('nested/fixture.txt'),
          'NESTED_FIXTURE\n',
        );
        await capture('native-files-conflict-recovery');
        await tap(s.filesBack);
        await tap(s.filesBack);
        await tap(s.filesBack);
        await tap(s.gitBack);
      });
      await e2e.phase('edge-stop-pending-approval', async () => {
        await startNewChat();
        await capture('edge-new-chat-before-approval-input');
        const known = new Set((await loadThreads()).map((entry) => entry.id));
        await type(
          s.message,
          'Call git_push now. The tool itself will request approval. Do not ask in prose or wait before calling it. Do not inspect anything first or call any other tool.',
        );
        await capture('edge-new-chat-before-approval-send');
        await tap(s.send);
        await capture('edge-new-chat-after-approval-send');
        await e2e.check(
          'sending a new local chat does not reopen the session list over its controls',
          async () => (await query(s.newChat, true)).length === 0,
        );
        await e2e.waitFor(
          'the model invokes the push tool and reaches its real approval',
          async () => (await query(s.approvalAllow, true)).length > 0,
          { timeoutMs: 300_000, intervalMs: 1000 },
        );
        let chat = (await loadThreads()).find((entry) => !known.has(entry.id));
        await e2e.check(
          'push has not run before approval',
          () =>
            chat.status === 'running' &&
            chat.messages.some(
              (entry) => entry.tool?.name === 'git_push' && entry.tool.status === 'pending',
            ),
        );
        await tap(s.stop);
        await e2e.waitFor(
          'Stop interrupts the pending approval durably',
          async () => {
            chat = (await loadThreads()).find((entry) => entry.id === chat.id);
            return chat.status === 'interrupted' && chat.activeTurnId === null;
          },
          { timeoutMs: 60_000 },
        );
        await settled();
        await e2e.check(
          'Stop removes both approval actions',
          async () => (await absent(s.approvalAllow)) && (await absent(s.approvalDeny)),
        );
        await e2e.check(
          'cancelled approval never becomes a successful push',
          () =>
            !chat.messages.some(
              (entry) => entry.tool?.name === 'git_push' && entry.tool.status === 'completed',
            ),
        );
        const prompt = 'Read seed.txt with read_file. Do not change files.';
        const resumed = await send(prompt, chat.id);
        const transcriptSettled = async () => {
          const activity = await query(s.activityEvent, true);
          const labels = await Promise.all(
            activity.map((entry) =>
              api(`/element/${Object.values(entry)[0]}/attribute/label`, undefined, 'GET'),
            ),
          );
          return (
            (await query(s.userMessageText(prompt), true)).length === 1 &&
            (await absent(s.activityError)) &&
            labels.every((label) => label.startsWith('Turn completed'))
          );
        };
        await e2e.waitFor(
          'the next transcript reconciles and leaves no running activity',
          transcriptSettled,
          {
            timeoutMs: 30_000,
          },
        );
        await e2e.expectEqual(
          'the new user request renders exactly once after cancellation',
          (await query(s.userMessageText(prompt), true)).length,
          1,
        );
        await e2e.check(
          'the completed next turn has no stale working or error state',
          transcriptSettled,
        );
        await capture('native-post-cancellation-recovery');
        await e2e.check('the next turn executes a fresh real file read', () =>
          resumed.messages.some(
            (entry) => entry.tool?.name === 'read_file' && entry.tool.status === 'completed',
          ),
        );
        await e2e.expectEqual(
          'Stop and recovery never duplicate a user message',
          resumed.messages.filter((entry) => entry.role === 'user').length,
          2,
        );
      });
      if (sharedWorkflowOnly) {
        return;
      }
      await e2e.phase('edge-unsupported-execution', async () => {
        await startNewChat();
        await tap(s.workspace);
        await tap(s.newWorkspace);
        await type(s.workspaceCreateInput, 'Unsupported actions fixture');
        await tap(s.workspaceCreateSubmit);
        await e2e.waitFor(
          'workspace creation returns to the selected, interactive chat',
          async () => {
            await source();
            const [chip] = await query(s.workspace, true);
            return (
              (await absent(s.workspaceCreateInput)) &&
              chip &&
              (
                await api(`/element/${Object.values(chip)[0]}/attribute/label`, undefined, 'GET')
              ).endsWith('Unsupported actions fixture')
            );
          },
          { timeoutMs: 30_000 },
        );
        const initialized = await send(
          'Initialize Git in this empty workspace. If you have no chat tool for this, explain where I can do it in the app. Do not edit files or substitute another tool.',
        );
        const empty = path.join(
          container,
          'Library/Application Support/OnDeviceAgent/workspaces',
          initialized.workspaceId,
          'repository',
        );
        await e2e.expectEqual(
          'requesting Git initialization through chat does not create a repository or files',
          await fs.readdir(empty),
          [],
        );
        const initReply = initialized.messages
          .filter((entry) => entry.role === 'assistant')
          .map((entry) => entry.content)
          .join('\n');
        await e2e.expectMatch(
          'the assistant points to the Git app action',
          initReply,
          /Initialize Git/iu,
        );
        await e2e.expectMatch(
          'the Git initialization answer describes the app rather than claiming tool execution',
          initReply,
          /app|screen|tap|open/iu,
        );
        await e2e.expectMatch(
          'Git setup guidance stays inside DapperCode',
          initReply,
          /DapperCode|this (?:app|chat|conversation)/iu,
        );
        await e2e.check(
          'Git setup never asks the user to install an unrelated app',
          () => !/App Store|download.{0,30}Git app|install.{0,30}Git app/iu.test(initReply),
        );
        const chat = await send(
          'Run the shell command printf UNSUPPORTED_EXECUTION > unsupported-execution.txt. If no execution tool exists, say so. Do not write a file as a substitute.',
          initialized.id,
        );
        await e2e.expectEqual(
          'unsupported shell execution still cannot mutate the empty workspace',
          await fs.readdir(empty),
          [],
        );
        const reply = chat.messages
          .slice(initialized.messages.length)
          .filter((entry) => entry.role === 'assistant')
          .map((entry) => entry.content)
          .join('\n');
        await e2e.expectMatch(
          'the assistant explains unavailable execution honestly',
          reply,
          /cannot|can't|unable|not (?:available|supported)|do not have|don't have|no (?:shell|terminal|tool)|does not (?:have|support)/iu,
        );
        await e2e.check(
          'the rendered answer does not expose a fabricated execution tool',
          () =>
            !chat.messages.some(
              (entry) => entry.tool && /exec|shell|git_init|terminal/u.test(entry.tool.name),
            ),
        );
        await tap(s.openGit);
        await find(s.gitSetup, true);
        await e2e.check(
          'the app still offers Git initialization in the correct empty workspace',
          async () => (await source()).includes('Unsupported actions fixture'),
        );
        await tap(s.gitBack);
      });
    },
  });
}
