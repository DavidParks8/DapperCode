import path from 'node:path';
import productScenario from './native-product.mjs';
import catalog from '../../../src/features/on-device/models/catalog.json' with { type: 'json' };
import { nativeOnDeviceSelectors as selectors } from '../../../../../e2e/fixtures/selectors.ts';

export const name = 'on-device-model-management';
export const contract = {
  requiredPhases: [
    'bundle',
    'prepare',
    'onboard',
    'settings',
    'model-download',
    'model-sheet',
    'management-secondary-download',
    'management-new-chat-selection',
    'management-default-resident-consistency',
    'management-settings-default-roundtrip',
    'management-existing-chat-switch',
    'management-selected-model-deletion',
  ],
};

function secondaryModel(primary) {
  // Cycling representatives covers each family as the deleted model as well as the fallback.
  const id = /bonsai/i.test(primary.family)
    ? 'gemma-4-e2b-q4-0'
    : /gemma/i.test(primary.family)
      ? 'qwen35-2b-q4-k-m'
      : 'bonsai-2-2b-q2-0';
  const model = catalog.find((entry) => entry.id === id);
  if (!model || model.runtimeIssue || model.id === primary.id) {
    throw new Error('Model management requires a runnable approved secondary model.');
  }
  return model;
}

export default async function scenario(e2e) {
  return productScenario(e2e, {
    afterModelSheet: async ({
      model: primary,
      container,
      api,
      query,
      find,
      tap,
      reveal,
      absent,
      capture,
      back,
      openDrawer,
      startNewChat,
      readJSON,
      type,
      loadThreads,
      openChat,
      repository,
    }) => {
      const secondary = secondaryModel(primary);
      const preferencesFile = path.join(
        container,
        'Library/Application Support/OnDeviceAgent/state/preferences.json',
      );
      const openModels = async () => {
        await openDrawer();
        await tap(selectors.settings);
        await tap(selectors.settingsModels);
        await find(selectors.modelLibrary);
        await find(selectors.modelSearch, true);
      };
      const expectHeader = async (model) => {
        await e2e.waitFor(
          `chat header uses ${model.id}`,
          async () => {
            const chip = await find(selectors.modelChip, true);
            return (
              (await api(`/element/${chip}/attribute/label`, undefined, 'GET')) ===
              `Model, ${model.name} ${model.quantization}`
            );
          },
          { timeoutMs: 15_000 },
        );
        const chip = await find(selectors.modelChip, true);
        await e2e.expectEqual(
          'the model header matches its authoritative selected model',
          await api(`/element/${chip}/attribute/label`, undefined, 'GET'),
          `Model, ${model.name} ${model.quantization}`,
        );
      };
      const readSeed = async (model, existingThread) => {
        const ids = new Set((await loadThreads()).map((entry) => entry.id));
        const previousMessages = existingThread?.messages.length ?? 0;
        await type(
          selectors.message,
          'Use read_file to read seed.txt and tell me its contents. Do not change any files.',
        );
        await tap(selectors.send);
        let result;
        await e2e.waitFor(
          `a real read through ${model.id} settles`,
          async () => {
            result = (await loadThreads()).find((entry) =>
              existingThread ? entry.id === existingThread.id : !ids.has(entry.id),
            );
            return (
              result?.messages.length > previousMessages &&
              ['complete', 'failed', 'interrupted'].includes(result.status)
            );
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        await e2e.expectEqual('the real selected-model turn completes', result.status, 'complete');
        await e2e.expectEqual(
          'the conversation records the selected model',
          result.modelId,
          model.id,
        );
        const read = result.messages
          .slice(previousMessages)
          .find((entry) => entry.tool?.name === 'read_file' && entry.tool.status === 'completed');
        await e2e.expectEqual(
          'the selected model consumes actual native file bytes',
          read ? JSON.parse(read.content).content : null,
          existingThread ? 'changed-after-model-switch\n' : 'fixture\n',
        );
        await e2e.check(
          'the model switch leaves stop controls settled',
          async () => (await absent(selectors.stop)) && (await absent(selectors.stopping)),
        );
        return result;
      };
      let conversation;

      await e2e.phase('management-secondary-download', async () => {
        await openModels();
        await find(selectors.modelUnload(primary.id));
        await e2e.check(
          'the primary model is resident before the secondary download',
          async () => (await query(selectors.modelUnload(primary.id))).length > 0,
        );
        await tap(selectors.modelFamily(secondary.family.toLowerCase().replaceAll(' ', '-')));
        await reveal(selectors.modelDownload(secondary.id));
        await tap(selectors.modelDownload(secondary.id));
        await e2e.waitFor(
          'secondary transfer has received bytes before pausing',
          async () => {
            const progress = (await query(selectors.modelProgress(secondary.id), true))[0];
            return (
              progress &&
              Number.parseFloat(
                String(
                  await api(
                    `/element/${Object.values(progress)[0]}/attribute/value`,
                    undefined,
                    'GET',
                  ),
                ),
              ) > 0
            );
          },
          { timeoutMs: 120_000 },
        );
        await tap(selectors.modelPause(secondary.id));
        const downloadLabel = async () =>
          api(
            `/element/${await find(selectors.modelDownload(secondary.id), true)}/attribute/label`,
            undefined,
            'GET',
          );
        await e2e.waitFor(
          'Pause offers Resume for the partial native transfer',
          async () => (await downloadLabel()).startsWith('Resume '),
          { timeoutMs: 30_000 },
        );
        await e2e.check(
          'paused secondary can resume without being marked ready',
          async () =>
            (await downloadLabel()).startsWith('Resume ') &&
            (await absent(selectors.modelLoad(secondary.id))),
        );
        await tap(selectors.modelDownload(secondary.id));
        await find(selectors.modelPause(secondary.id), true);
        await tap(selectors.modelCancel(secondary.id));
        await e2e.waitFor(
          'Cancel returns the secondary to Download, not Load',
          async () =>
            (await downloadLabel()).startsWith('Download ') &&
            (await absent(selectors.modelLoad(secondary.id))),
          { timeoutMs: 30_000 },
        );
        await e2e.check(
          'cancelled transfer is not ready or resident',
          async () =>
            (await downloadLabel()).startsWith('Download ') &&
            (await absent(selectors.modelUnload(secondary.id))),
        );
        await tap(selectors.modelDownload(secondary.id));
        await e2e.waitFor(
          'the second app-driven download is verified without loading it',
          async () => (await query(selectors.modelLoad(secondary.id))).length > 0,
          { timeoutMs: 900_000, intervalMs: 1_000 },
        );
        await e2e.check('the secondary download action is replaced by Load', () =>
          absent(selectors.modelDownload(secondary.id)),
        );
        await e2e.check('downloading the secondary does not make it resident', () =>
          absent(selectors.modelUnload(secondary.id)),
        );
        await capture('management-secondary-downloaded');
        await back(selectors.familyPage);
        await e2e.check(
          'downloading another family preserves the resident primary',
          async () => (await query(selectors.modelUnload(primary.id))).length > 0,
        );
        await back(selectors.modelLibrary);
        await startNewChat();
      });

      await e2e.phase('management-new-chat-selection', async () => {
        await tap(selectors.modelChip);
        await find(selectors.downloadMoreModels);
        await tap(selectors.modelOption(secondary));
        await e2e.waitFor(
          'choosing the second downloaded model closes the shared picker',
          () => absent(selectors.downloadMoreModels),
          { timeoutMs: 15_000 },
        );
        await e2e.waitFor(
          'the new-chat header displays the selected secondary model',
          async () => {
            const chip = await find(selectors.modelChip);
            return (
              (await api(`/element/${chip}/attribute/label`, undefined, 'GET')) ===
              `Model, ${secondary.name} ${secondary.quantization}`
            );
          },
          { timeoutMs: 15_000 },
        );
        const chip = await find(selectors.modelChip);
        await e2e.expectEqual(
          'the visible new-chat model header exactly matches the secondary',
          await api(`/element/${chip}/attribute/label`, undefined, 'GET'),
          `Model, ${secondary.name} ${secondary.quantization}`,
        );
        await capture('management-new-chat-secondary-selected');
      });

      await e2e.phase('management-default-resident-consistency', async () => {
        await openModels();
        await find(selectors.modelUnload(primary.id));
        e2e.writeFile(
          'logs/management-default-checkpoint.json',
          JSON.stringify({
            primary: primary.id,
            secondary: secondary.id,
            preferences: await readJSON(preferencesFile),
          }),
        );
        await capture('management-default-resident-checkpoint');
        await e2e.waitFor(
          'Settings In use includes the new-chat default as well as the resident model',
          async () => (await query(selectors.modelRow(secondary.id))).length > 0,
          { timeoutMs: 15_000 },
        );
        await e2e.check(
          'the resident primary offers Use for new chats after choosing the secondary',
          async () => (await query(selectors.modelUseForNewChats(primary.id))).length > 0,
        );
        await e2e.check(
          'choosing a new-chat model does not unload the primary',
          async () => (await query(selectors.modelUnload(primary.id))).length > 0,
        );
        await e2e.check('choosing a new-chat model does not eagerly load the secondary', () =>
          absent(selectors.modelUnload(secondary.id)),
        );
        await e2e.check(
          'the downloaded secondary remains available to load',
          async () => (await query(selectors.modelLoad(secondary.id))).length > 0,
        );
        await e2e.expectEqual(
          'the persisted runtime default agrees with the visible new-chat selection',
          (await readJSON(preferencesFile)).modelId,
          secondary.id,
        );
        await capture('management-default-resident-consistent');
      });
      await e2e.phase('management-settings-default-roundtrip', async () => {
        await tap(selectors.modelUseForNewChats(primary.id));
        await e2e.waitFor(
          'Settings saves the resident primary as the default',
          async () => (await readJSON(preferencesFile)).modelId === primary.id,
          { timeoutMs: 15_000 },
        );
        await e2e.check(
          'changing the Settings default preserves residency',
          async () =>
            (await query(selectors.modelUnload(primary.id))).length > 0 &&
            (await query(selectors.modelUnload(secondary.id))).length === 0,
        );
        await back(selectors.modelLibrary);
        await startNewChat();
        await expectHeader(primary);
        conversation = await readSeed(primary);
      });
      await e2e.phase('management-existing-chat-switch', async () => {
        const history = structuredClone(conversation.messages);
        await tap(selectors.modelChip);
        await find(selectors.downloadMoreModels);
        await tap(selectors.modelOption(secondary));
        await e2e.waitFor(
          'an existing chat saves its different model without making a new thread',
          async () =>
            (await loadThreads()).find((entry) => entry.id === conversation.id)?.modelId ===
            secondary.id,
          { timeoutMs: 15_000 },
        );
        await expectHeader(secondary);
        await e2e.expectEqual(
          'switching a conversation preserves all prior messages',
          (await loadThreads()).find((entry) => entry.id === conversation.id).messages,
          history,
        );
        await openModels();
        await e2e.check(
          'choosing a conversation model is lazy, not an eager native reload',
          async () =>
            (await query(selectors.modelUnload(primary.id))).length > 0 &&
            (await query(selectors.modelUnload(secondary.id))).length === 0,
        );
        await tap(selectors.modelLoad(secondary.id));
        await e2e.waitFor(
          'loading another model replaces the resident context',
          async () =>
            (await query(selectors.modelUnload(secondary.id))).length > 0 &&
            (await query(selectors.modelUnload(primary.id))).length === 0,
          { timeoutMs: 180_000, intervalMs: 1_000 },
        );
        await tap(selectors.modelFamily(primary.family.toLowerCase().replaceAll(' ', '-')));
        await reveal(selectors.modelLoad(primary.id));
        await e2e.check(
          'the previous model remains downloaded after a native context switch',
          async () => (await query(selectors.modelLoad(primary.id))).length > 0,
        );
        await back(selectors.familyPage);
        await back(selectors.modelLibrary);
        const changedSeed = e2e.writeFile('data/changed-seed.txt', 'changed-after-model-switch\n');
        await e2e.run('cp', [changedSeed, path.join(repository, 'seed.txt')]);
        await openChat(conversation.id);
        conversation = await readSeed(secondary, conversation);
        await capture('management-switched-conversation');
      });
      await e2e.phase('management-selected-model-deletion', async () => {
        const history = structuredClone(conversation.messages);
        await openModels();
        await find(selectors.modelDelete(secondary.id), true);
        await tap(selectors.modelDelete(secondary.id));
        await e2e.waitFor(
          'deleting the selected resident model clears its default and unloads it',
          async () =>
            (await readJSON(preferencesFile)).modelId === null &&
            (await query(selectors.modelUnload(secondary.id))).length === 0,
          { timeoutMs: 60_000, intervalMs: 500 },
        );
        await tap(selectors.modelFamily(secondary.family.toLowerCase().replaceAll(' ', '-')));
        await reveal(selectors.modelDownload(secondary.id));
        await e2e.check(
          'deleted weights offer Download instead of Load or Delete',
          async () =>
            (await query(selectors.modelDownload(secondary.id))).length > 0 &&
            (await query(selectors.modelLoad(secondary.id))).length === 0 &&
            (await query(selectors.modelDelete(secondary.id))).length === 0,
        );
        await back(selectors.familyPage);
        await back(selectors.modelLibrary);
        await startNewChat();
        await expectHeader(primary);
        const preserved = (await loadThreads()).find((entry) => entry.id === conversation.id);
        await e2e.expectEqual(
          'deleting model weights never removes or rewrites conversation history',
          preserved.messages,
          history,
        );
        await e2e.expectEqual(
          'historical model identity is not silently replaced by the new default',
          preserved.modelId,
          secondary.id,
        );
        await openChat(conversation.id);
        await find(selectors.message, true);
        await e2e.check(
          'the historical conversation stays settled and readable after model deletion',
          async () => (await absent(selectors.stop)) && (await absent(selectors.stopping)),
        );
        await capture('management-deleted-model-history');
      });
    },
  });
}
