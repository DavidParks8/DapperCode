import path from 'node:path';
import productScenario from './native-product.mjs';
import catalog from '../../../src/features/on-device/models/catalog.json' with { type: 'json' };
import { nativeOnDeviceSelectors as selectors } from '../../../../../e2e/fixtures/selectors.ts';

export const name = 'on-device-model-transitions';
export const contract = {
  requiredPhases: [
    'bundle',
    'prepare',
    'onboard',
    'settings',
    'model-download',
    'model-sheet',
    'transition-existing-chat',
    'transition-download',
    'transition-immediate-send',
    'transition-independent-default',
    'transition-return-existing',
  ],
};

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
      startNewChat,
      readJSON,
      type,
      loadThreads,
      openChat,
      repository,
    }) => {
      const secondary = catalog.find((entry) => entry.id === 'qwen35-0.8b-q4-0');
      if (primary.id !== 'bonsai-2-2b-q2-0' || !secondary || secondary.runtimeIssue) {
        throw new Error('Transition coverage requires Bonsai A and runnable Qwen3.5 0.8B B.');
      }
      const preferences = path.join(
        container,
        'Library/Application Support/OnDeviceAgent/state/preferences.json',
      );
      const chatRoute = async () => {
        const events = await readJSON(path.join(container, 'Documents/product-navigation.json'));
        const visit = (state) => {
          for (const route of state?.routes ?? []) {
            if (route.name === 'chats/[chatId]') {
              const screen = route.state?.routes.find((entry) => entry.name === 'index');
              return {
                drawerKey: route.key,
                screenKey: screen?.key,
                chatId: screen?.params?.chatId,
              };
            }
            const nested = visit(route.state);
            if (nested) {
              return nested;
            }
          }
          return null;
        };
        const route = visit(events.at(-1)?.state);
        if (!route?.screenKey || !route.chatId) {
          throw new Error('Expected the existing production chat route identity.');
        }
        return route;
      };
      const prompt =
        'Use read_file to read seed.txt and tell me its contents. Do not change any files.';
      const continuationPrompt =
        'Use read_file to read transition.txt and tell me its contents. Do not change any files.';
      const header = async (model) => {
        const chip = await find(selectors.modelChip, true);
        await e2e.expectEqual(
          'the header identifies the selected conversation model',
          await api(`/element/${chip}/attribute/label`, undefined, 'GET'),
          `Model, ${model.name} ${model.quantization}`,
        );
      };
      const settledRead = async (model, previous, bytes) => {
        let result;
        await e2e.waitFor(
          'the selected model completes its real native read',
          async () => {
            result = (await loadThreads()).find((entry) =>
              previous ? entry.id === previous.id : true,
            );
            return (
              result?.messages.length > (previous?.messages.length ?? 0) &&
              ['complete', 'failed', 'interrupted'].includes(result.status)
            );
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        await e2e.expectEqual('the turn completes successfully', result.status, 'complete');
        await e2e.expectEqual('the durable chat uses the selected model', result.modelId, model.id);
        const read = result.messages
          .slice(previous?.messages.length ?? 0)
          .find((entry) => entry.tool?.name === 'read_file' && entry.tool.status === 'completed');
        await e2e.expectEqual(
          'the selected native context consumes the current workspace bytes',
          read ? JSON.parse(read.content).content : null,
          bytes,
        );
        await e2e.check(
          'Stop and Stopping settle together',
          async () => (await absent(selectors.stop)) && (await absent(selectors.stopping)),
        );
        return result;
      };
      let original;
      let switched;
      let sibling;
      let originalRoute;
      await e2e.phase('transition-existing-chat', async () => {
        await header(primary);
        await type(selectors.message, prompt);
        await tap(selectors.send);
        original = await settledRead(primary, null, 'fixture\n');
        originalRoute = await chatRoute();
        await tap(selectors.modelChip);
        await e2e.check('B is absent before its download', () =>
          absent(selectors.modelOption(secondary)),
        );
        await tap(selectors.sheetClose);
        await type(selectors.message, continuationPrompt);
        await e2e.expectEqual(
          'only the original conversation exists',
          (await loadThreads()).length,
          1,
        );
      });
      await e2e.phase('transition-download', async () => {
        await tap(selectors.modelChip);
        await tap(selectors.downloadMoreModels);
        await find(selectors.modelLibrary);
        await tap(selectors.modelFamily(secondary.family.toLowerCase().replaceAll(' ', '-')));
        await reveal(selectors.modelDownload(secondary.id));
        await tap(selectors.modelDownload(secondary.id));
        await e2e.waitFor(
          'B finishes the real download and verification',
          async () => (await query(selectors.modelLoad(secondary.id))).length > 0,
          { timeoutMs: 900_000, intervalMs: 1_000 },
        );
        await e2e.check('download never implicitly loads B', () =>
          absent(selectors.modelUnload(secondary.id)),
        );
        await back(selectors.familyPage);
        await back(selectors.modelLibrary);
        await openChat(original.id);
        await e2e.expectEqual(
          'returning from the Settings drawer reuses the same mounted chat route',
          await chatRoute(),
          originalRoute,
        );
        const composer = await find(selectors.message, true);
        await e2e.expectEqual(
          'returning directly preserves the unsent draft',
          await api(`/element/${composer}/attribute/value`, undefined, 'GET'),
          continuationPrompt,
        );
        await header(primary);
        await e2e.expectEqual(
          'download preserves existing history',
          (await loadThreads()).find((entry) => entry.id === original.id).messages,
          original.messages,
        );
      });
      await e2e.phase('transition-immediate-send', async () => {
        const changed = e2e.writeFile('data/transition-seed.txt', 'changed-after-transition\n');
        await e2e.run('cp', [changed, path.join(repository, 'transition.txt')]);
        await tap(selectors.modelChip);
        await tap(selectors.modelOption(secondary));
        await tap(selectors.send);
        switched = await settledRead(secondary, original, 'changed-after-transition\n');
        await e2e.expectEqual(
          'switching retains the original history prefix',
          switched.messages.slice(0, original.messages.length),
          original.messages,
        );
        await e2e.expectEqual(
          'switching preserves workspace identity',
          switched.workspaceId,
          original.workspaceId,
        );
        await e2e.expectEqual(
          'switching does not create another chat',
          (await loadThreads()).length,
          1,
        );
        await e2e.expectEqual(
          'existing-chat selection also saves the new-chat default',
          (await readJSON(preferences)).modelId,
          secondary.id,
        );
        await header(secondary);
        await capture('transition-lazy-send-complete');
      });
      await e2e.phase('transition-independent-default', async () => {
        await startNewChat();
        await header(secondary);
        await tap(selectors.modelChip);
        await tap(selectors.modelOption(primary));
        await e2e.waitFor(
          'the new-chat default becomes A',
          async () => (await readJSON(preferences)).modelId === primary.id,
          { timeoutMs: 15_000 },
        );
        await e2e.expectEqual(
          'changing the default does not rewrite existing T',
          (await loadThreads()).find((entry) => entry.id === original.id).modelId,
          secondary.id,
        );
        await header(primary);
        await type(selectors.message, continuationPrompt);
        await tap(selectors.send);
        let created;
        await e2e.waitFor(
          'the sibling A chat completes',
          async () => {
            created = (await loadThreads()).find((entry) => entry.id !== original.id);
            return created?.status === 'complete';
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        sibling = await settledRead(
          primary,
          { ...created, messages: [] },
          'changed-after-transition\n',
        );
        await e2e.expectEqual(
          'the newly created sibling is the A conversation',
          sibling.id,
          created.id,
        );
      });
      await e2e.phase('transition-return-existing', async () => {
        await openChat(original.id);
        await header(secondary);
        const fresh = e2e.writeFile('data/return-seed.txt', 'fresh-on-return\n');
        await e2e.run('cp', [fresh, path.join(repository, 'return.txt')]);
        await type(
          selectors.message,
          'Use read_file to read return.txt and tell me its contents. Do not change any files.',
        );
        await tap(selectors.send);
        const final = await settledRead(secondary, switched, 'fresh-on-return\n');
        await e2e.expectEqual(
          'the sibling keeps its own model',
          (await loadThreads()).find((entry) => entry.id === sibling.id).modelId,
          primary.id,
        );
        await e2e.expectEqual(
          'returning to T does not rewrite the new-chat default',
          (await readJSON(preferences)).modelId,
          primary.id,
        );
        await e2e.expectEqual(
          'T retains all prior completed tool history',
          final.messages.slice(0, switched.messages.length),
          switched.messages,
        );
        await e2e.expectEqual('exactly two conversations remain', (await loadThreads()).length, 2);
        await capture('transition-independent-identities');
      });
    },
  });
}
