import fs from 'node:fs/promises';
import path from 'node:path';
import { bundleNativeReactApp } from './bundleNativeReactApp.mjs';
import catalog from '../../../src/features/on-device/models/catalog.json' with { type: 'json' };
import { nativeOnDeviceSelectors as selectors } from '../../../../../e2e/fixtures/selectors.ts';

/**
 * The production On this iPhone experience on a real simulator with real weights: onboarding opens
 * the built-in profile in the shared chat shell, Settings manages models and Git & GitHub, the model
 * sheet and workspace picker drive a real offline tool-using turn, and drafts, history, stop on
 * background, and profile switching survive the app lifecycle.
 */
export const name = 'on-device-offline-product';
export const contract = {
  requiredPhases: [
    'bundle',
    'prepare',
    'onboard',
    'settings',
    'model-sheet',
    'offline-turn',
    'cold-recovery',
    'stop-background',
    'switch-profile',
  ],
};

export default async function scenario(e2e) {
  const mobile = path.join(e2e.worktree, 'apps/mobile');
  const sources = path.join(mobile, 'modules/on-device-agent/tests');
  const model = catalog.find((entry) => entry.id === 'qwen3-1.7b-q4-k-m');
  const bundleId = 'dev.dappercode.offline-product';
  let simulator;
  let booted = false;
  let appium;
  let endpoint;
  let session;
  let container;
  let workspace;
  let repository;
  let thread;
  const gitEnvironment = {
    HOME: e2e.dataDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  };
  const git = (args) => e2e.run('git', args, { env: gitEnvironment });
  const readJSON = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
  const command = async (route, body, method = 'POST') => {
    const result = await e2e.requestHttp({
      url: `${endpoint}${route}`,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      timeoutMs: 180_000,
      maxBodyBytes: 8 * 1024 * 1024,
    });
    return JSON.parse(result.text).value;
  };
  const api = (route, body, method) => command(`/session/${session}${route}`, body, method);
  const query = (selector) =>
    api(
      '/elements',
      typeof selector === 'string'
        ? { using: 'accessibility id', value: selector }
        : { using: '-ios predicate string', value: selector.predicate },
    );
  const describe = (selector) => (typeof selector === 'string' ? selector : selector.predicate);
  const find = async (selector) => {
    let element;
    await e2e.waitFor(
      `visible native control: ${describe(selector)}`,
      async () => {
        element = (await query(selector)).find((entry) => Boolean(entry));
        return Boolean(element);
      },
      { timeoutMs: 30_000, intervalMs: 300 },
    );
    return Object.values(element)[0];
  };
  const absent = async (selector) => (await query(selector)).length === 0;
  const tap = async (selector) => {
    const element = await find(selector);
    await e2e.waitFor(
      `enabled native control: ${describe(selector)}`,
      () => api(`/element/${element}/enabled`, undefined, 'GET'),
      { timeoutMs: 15_000 },
    );
    return api(`/element/${element}/click`, {});
  };
  const type = async (selector, text) => api(`/element/${await find(selector)}/value`, { text });
  const source = () => api('/source', undefined, 'GET');
  const capture = async (name) => {
    // Let navigation and sheet transitions settle; streaming screens may never be fully still.
    let previous;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await source();
      if (current === previous) {
        break;
      }
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const screenshot = await api('/screenshot', undefined, 'GET');
    e2e.writeFile(`logs/${name}.png`, Buffer.from(screenshot, 'base64'));
    e2e.writeFile(`logs/${name}.xml`, await source());
  };
  // Wait for the pop to finish so a following tap cannot land on the outgoing page.
  const back = async (leaving) => {
    await tap(selectors.settingsBack);
    await e2e.waitFor(`settings page closed: ${describe(leaving)}`, () => absent(leaving), {
      timeoutMs: 15_000,
    });
  };
  const openDrawer = () => tap(selectors.openDrawer);
  const openChat = async (id) => {
    await openDrawer();
    await tap(`${selectors.chatRowPrefix}${id}`);
  };
  const startNewChat = async () => {
    await openDrawer();
    await tap(selectors.newChat);
    await find(selectors.runTarget);
  };
  const runtimeRoot = () => path.join(container, 'Library/Application Support/OnDeviceAgent/state');
  // Each conversation is a base document plus journal segments written after it (see
  // runtime/threadJournal.ts); replay them as the runtime does at startup. A compaction can
  // remove a segment between listing and reading it, so a vanished file restarts the read.
  const loadThreads = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readThreadJournals();
      } catch (error) {
        if (error?.code !== 'ENOENT' || attempt >= 4) {
          throw error;
        }
      }
    }
  };
  const readThreadJournals = async () => {
    const names = await fs.readdir(runtimeRoot());
    return Promise.all(
      names
        .filter((name) => name.startsWith('thread-'))
        .map(async (name) => {
          let thread = await readJSON(path.join(runtimeRoot(), name));
          const segments = names
            .map((entry) => entry.match(/^threadseg-([a-f0-9-]{36})-(\d{10,})\.json$/u))
            .filter((match) => match?.[1] === thread.id && Number(match[2]) > thread.segment)
            .sort((left, right) => Number(left[2]) - Number(right[2]));
          for (const [segmentName] of segments) {
            const delta = await readJSON(path.join(runtimeRoot(), segmentName));
            const removed = new Set(delta.remove);
            const messages = thread.messages.filter((message) => !removed.has(message.id));
            for (const message of delta.messages) {
              const position = messages.findIndex((entry) => entry.id === message.id);
              messages.splice(
                position < 0 ? messages.length : position,
                position < 0 ? 0 : 1,
                message,
              );
            }
            thread = { ...thread, ...delta.set, messages };
          }
          return thread;
        }),
    );
  };
  // The shared composer persists drafts per profile, the same for desktop and local chats.
  const localDrafts = async () => {
    try {
      const file = path.join(container, 'Documents/dappercode-profile-on-device-chat-drafts.json');
      return JSON.stringify(await readJSON(file));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  };
  try {
    let app;
    await e2e.phase('bundle', async () => {
      app = await bundleNativeReactApp(e2e, {
        entryFile: path.join(sources, 'product-entry.tsx'),
        bundleId,
        name: 'OfflineProduct',
      });
      const executable = await e2e.run('which', ['appium']);
      await e2e.acquireLease('dappercode-native-product-wda-8100-mjpeg-9100', {
        timeoutMs: 180_000,
      });
      appium = await e2e.start(
        'node',
        [path.join(sources, 'appium-server.mjs'), executable.stdout.trim()],
        { label: 'appium' },
      );
      const port = await e2e.waitForLog('appium', /NATIVE_APPIUM_PORT=(\d+)/, {
        timeoutMs: 30_000,
      });
      endpoint = `http://127.0.0.1:${port[1]}`;
      await e2e.requestHttp({ url: `${endpoint}/status`, expectJson: { value: { ready: true } } });
      await e2e.check('production router bundle and owned Appium server are ready', () => true);
    });
    await e2e.phase('prepare', async () => {
      const weights = path.join(e2e.workspaceDir, 'model.gguf');
      await e2e.run(
        'curl',
        ['--fail', '--location', '--max-time', '180', '--output', weights, model.downloadUrl],
        { timeoutMs: 190_000 },
      );
      const created = await e2e.run('xcrun', [
        'simctl',
        'create',
        e2e.runId,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      ]);
      simulator = created.stdout.trim();
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      booted = true;
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 120_000 });
      await e2e.run('xcrun', ['simctl', 'install', simulator, app], { timeoutMs: 120_000 });
      const data = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      container = data.stdout.trim();
      await e2e.run('cp', [weights, path.join(container, 'Documents/model.gguf')]);
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId], { timeoutMs: 60_000 });
      await e2e.waitFor(
        'native model verification and workspace preparation',
        async () => {
          try {
            workspace = (await readJSON(path.join(container, 'Documents/product-prepared.json')))
              .workspaceId;
            return Boolean(workspace);
          } catch (error) {
            if (error.code === 'ENOENT') {
              return false;
            }
            throw error;
          }
        },
        { timeoutMs: 120_000, intervalMs: 500 },
      );
      repository = path.join(
        container,
        'Library/Application Support/OnDeviceAgent/workspaces',
        workspace,
        'repository',
      );
      await git(['-C', repository, 'init', '--initial-branch=main']);
      const seed = e2e.writeFile('data/seed.txt', 'fixture\n');
      await e2e.run('cp', [seed, path.join(repository, 'seed.txt')]);
      await git(['-C', repository, 'add', '.']);
      await git([
        '-C',
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'seed',
      ]);
      const resume = e2e.writeFile('data/continue-boot', 'ready');
      await e2e.run('cp', [resume, path.join(container, 'Documents/continue-boot')]);
      const createdSession = await command('/session', {
        capabilities: {
          alwaysMatch: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:udid': simulator,
            'appium:bundleId': bundleId,
            'appium:noReset': true,
            'appium:autoLaunch': false,
            'appium:isHeadless': true,
            'appium:platformVersion': '27.0',
            'appium:newCommandTimeout': 1200,
            'appium:waitForIdleTimeout': 0,
            'appium:wdaLaunchTimeout': 120000,
            'appium:derivedDataPath': path.join(e2e.runtimeDir, 'wda'),
            'appium:useNewWDA': true,
            'appium:autoAcceptAlerts': true,
          },
        },
      });
      session = createdSession.sessionId;
      await e2e.check(
        'native fixture uses verified weights and only its disposable simulator container',
        () => Boolean(workspace && session),
      );
    });
    await e2e.phase('onboard', async () => {
      await tap(selectors.entry);
      await find(selectors.runTarget);
      await e2e.check(
        'onboarding opens On this iPhone as a profile in the shared chat shell',
        async () => {
          const xml = await source();
          return (
            xml.includes(selectors.localProfile) && (await find(selectors.message)) !== undefined
          );
        },
      );
      // A prepared model, workspace, and author leave only "Start your first chat"; the guide stays
      // until the first local chat has a message.
      await e2e.check(
        'the setup guide marks prepared steps done until the first chat starts',
        async () => {
          const xml = await source();
          return (
            !(await absent(selectors.setupGuide)) &&
            xml.includes('1. Download a model, Done') &&
            xml.includes('2. Clone or create a workspace, Done') &&
            xml.includes('3. Add a Git author, Done') &&
            xml.includes('4. Start your first chat, Ready')
          );
        },
      );
      await capture('on-device-new-chat');
    });
    await e2e.phase('settings', async () => {
      await openDrawer();
      await tap(selectors.settings);
      await tap(selectors.settingsModels);
      await find(selectors.modelLibrary);
      await find(selectors.qwen35Family);
      await capture('on-device-models');
      await e2e.check(
        'the model library lists modern families without inline quant actions',
        async () => {
          const xml = await source();
          return (
            xml.includes('Bonsai 2') &&
            xml.includes('Qwen3.5') &&
            xml.includes('Gemma 4') &&
            !xml.includes('Load and use')
          );
        },
      );
      await e2e.check('the model library labels simulator memory as an estimate', async () =>
        (await source()).includes('simulator estimate'),
      );
      await tap(selectors.qwen35Family);
      await find(selectors.familyPage);
      await e2e.waitFor(
        'Qwen sizes and quants are pushed onto the Settings stack',
        async () => {
          const xml = await source();
          return xml.includes('0.8B') && xml.includes('Q4_0') && xml.includes('Q8_0');
        },
        { timeoutMs: 30_000 },
      );
      await capture('on-device-quants');
      await back(selectors.familyPage);
      await tap(selectors.bonsaiFamily);
      await e2e.waitFor(
        'Bonsai fork-only packings are clearly unsupported',
        async () => (await source()).includes('Not supported in this build'),
        { timeoutMs: 30_000 },
      );
      await capture('on-device-bonsai-quants');
      await back(selectors.familyPage);
      await tap(selectors.gemmaFamily);
      await e2e.waitFor(
        'Gemma family exposes its actual quant choices',
        async () => {
          const xml = await source();
          return xml.includes('E2B') && xml.includes('Q4_0') && xml.includes('Q8_0');
        },
        { timeoutMs: 30_000 },
      );
      await capture('on-device-gemma-quants');
      await back(selectors.familyPage);
      await back(selectors.modelLibrary);
      await tap(selectors.gitAccount);
      await find(selectors.gitAccountPage);
      await e2e.check('unconfigured GitHub sign-in is explicit', async () =>
        Boolean(await find(selectors.githubUnavailable)),
      );
      await capture('on-device-git-account');
      await back(selectors.gitAccountPage);
      await startNewChat();
    });
    await e2e.phase('model-sheet', async () => {
      const workspaceChip = await find(selectors.workspace);
      await e2e.expectMatch(
        'the shared workspace picker shows the native workspace',
        await api(`/element/${workspaceChip}/attribute/label`, undefined, 'GET'),
        /Offline UI fixture/,
      );
      await tap(selectors.modelChip);
      await find(selectors.downloadMoreModels);
      await e2e.check('the shared model sheet lists the downloaded device model', async () =>
        (await source()).includes('Qwen3 1.7B'),
      );
      await capture('on-device-model-sheet');
      await tap(selectors.sheetClose);
      await e2e.waitFor('model sheet closes', () => absent(selectors.downloadMoreModels), {
        timeoutMs: 15_000,
      });
    });
    await e2e.phase('offline-turn', async () => {
      await type(
        selectors.message,
        'Use write_file to create offline.txt containing exactly OFFLINE_PRODUCT_OK. Then use git_stage for offline.txt and git_commit with message offline fixture. You must use those tools, not describe commands. Do not push. Report the resulting commit.',
      );
      const sendButton = await find(selectors.send);
      const sendBounds = await api(`/element/${sendButton}/rect`, undefined, 'GET');
      const keyboards = await api('/elements', {
        using: 'class name',
        value: 'XCUIElementTypeKeyboard',
      });
      const keyboardBounds = await api(
        `/element/${Object.values(keyboards[0])[0]}/rect`,
        undefined,
        'GET',
      );
      await e2e.check(
        'composer send control remains above the real iOS keyboard',
        () => sendBounds.y + sendBounds.height <= keyboardBounds.y && sendBounds.height >= 44,
      );
      await capture('on-device-keyboard-chat');
      await tap(selectors.send);
      await find(selectors.stop);
      await capture('on-device-generating-chat');
      await e2e.waitFor(
        'real production local agent file-stage-commit turn',
        async () => {
          thread = (await loadThreads())[0];
          return (
            thread?.status === 'complete' ||
            thread?.status === 'failed' ||
            thread?.status === 'interrupted'
          );
        },
        { timeoutMs: 900_000, intervalMs: 1000 },
      );
      await e2e.check('local run completes with durable native tool evidence', () => {
        if (thread.status !== 'complete') {
          throw new Error(thread.lastError);
        }
        return ['write_file', 'git_stage', 'git_commit'].every((name) =>
          thread.messages.some(
            (message) => message.tool?.name === name && message.tool.status === 'completed',
          ),
        );
      });
      const contents = await git(['-C', repository, 'show', 'HEAD:offline.txt']);
      await e2e.expectEqual(
        'native offline commit contains actual model-written data',
        contents.stdout.trim(),
        'OFFLINE_PRODUCT_OK',
      );
      const hash = await git(['-C', repository, 'rev-parse', 'HEAD']);
      await e2e.check('tool journal records the actual native Git commit hash', () =>
        thread.messages.some(
          (entry) =>
            entry.tool?.name === 'git_commit' && entry.content.includes(hash.stdout.trim()),
        ),
      );
      await e2e.waitFor(
        'shared composer settles after native generation',
        async () => (await absent(selectors.stop)) && (await absent(selectors.stopping)),
        { timeoutMs: 30_000 },
      );
      await capture('on-device-chat');
      await e2e.check('the setup guide is gone once the first local chat has a message', () =>
        absent(selectors.setupGuide),
      );
      const network = await readJSON(path.join(container, 'Documents/product-network.json'));
      await e2e.expectEqual(
        'no network request or fallback was used for the offline turn',
        network.networkRequests,
        0,
      );
    });
    await e2e.phase('cold-recovery', async () => {
      await type(selectors.message, 'durable offline draft');
      await api('/execute/sync', { script: 'mobile: pressButton', args: [{ name: 'home' }] });
      await e2e.waitFor(
        'shared composer draft is persisted for the local profile',
        async () => (await localDrafts()).includes('durable offline draft'),
        { timeoutMs: 30_000 },
      );
      await api('/execute/sync', { script: 'mobile: terminateApp', args: [{ bundleId }] });
      await api('/execute/sync', { script: 'mobile: activateApp', args: [{ bundleId }] });
      const input = await find(selectors.message);
      await e2e.waitFor(
        'cold launch reopens the local profile chat with its draft',
        async () =>
          (await api(`/element/${input}/attribute/value`, undefined, 'GET')) ===
          'durable offline draft',
        { timeoutMs: 30_000 },
      );
      await e2e.check('the setup guide stays gone after a cold launch', () =>
        absent(selectors.setupGuide),
      );
      const restored = (await loadThreads()).find((entry) => entry.id === thread.id);
      await e2e.expectEqual(
        'cold launch preserves settled tool journal exactly',
        restored.messages,
        thread.messages,
      );
      await capture('on-device-cold-chat');
      await api('/execute/sync', { script: 'mobile: terminateApp', args: [{ bundleId }] });
      const uncertain = structuredClone(thread);
      uncertain.status = 'running';
      uncertain.activeTurnId = 'fixture-interrupted-turn';
      const commitIndex = uncertain.messages.findIndex(
        (entry) => entry.tool?.name === 'git_commit',
      );
      uncertain.messages = uncertain.messages.slice(0, commitIndex + 1);
      uncertain.messages[commitIndex].tool.status = 'running';
      uncertain.messages[commitIndex].content = '';
      // Settling a run is journaled as a segment after the base, so the injected crash state must
      // be the conversation's latest journal position: a base that contains every segment, with
      // the segments removed, as a compaction of the crashed state would leave it.
      const segments = (await fs.readdir(runtimeRoot())).filter((name) =>
        name.startsWith(`threadseg-${thread.id}-`),
      );
      uncertain.segment = Math.max(
        thread.segment,
        ...segments.map((name) => Number(name.slice(`threadseg-${thread.id}-`.length, -5))),
      );
      const injected = e2e.writeFile('data/interrupted-thread.json', JSON.stringify(uncertain));
      await e2e.run('cp', [injected, path.join(runtimeRoot(), `thread-${thread.id}.json`)]);
      for (const name of segments) {
        await fs.rm(path.join(runtimeRoot(), name));
      }
      await api('/execute/sync', { script: 'mobile: activateApp', args: [{ bundleId }] });
      await openChat(thread.id);
      await e2e.waitFor(
        'uncertain tool is shown as interrupted in the shared transcript',
        async () => (await source()).includes('Interrupted'),
        { timeoutMs: 30_000 },
      );
      const recovered = (await loadThreads()).find((entry) => entry.id === thread.id);
      await e2e.check(
        'cold recovery marks uncertain commits interrupted without replaying turns',
        () =>
          recovered.status === 'interrupted' &&
          recovered.activeTurnId === null &&
          recovered.messages.length === uncertain.messages.length &&
          recovered.messages.at(-1).tool.status === 'interrupted',
      );
      const count = await git(['-C', repository, 'rev-list', '--count', 'HEAD']);
      await e2e.expectEqual(
        'interrupted commit recovery cannot create duplicate commits',
        count.stdout.trim(),
        '2',
      );
      await capture('on-device-recovered-chat');
    });
    await e2e.phase('stop-background', async () => {
      await startNewChat();
      await type(
        selectors.message,
        'List the numbers from 1 to 10000 separated by commas. Do not stop early.',
      );
      await tap(selectors.send);
      await find(selectors.stop);
      // The cold launch unloaded the model; the turn is journaled only once it has loaded.
      await e2e.waitFor(
        'the local turn is journaled and running',
        async () =>
          (await loadThreads()).some(
            (entry) => entry.id !== thread.id && entry.status === 'running',
          ),
        { timeoutMs: 120_000, intervalMs: 500 },
      );
      await api('/execute/sync', { script: 'mobile: pressButton', args: [{ name: 'home' }] });
      // Settling while backgrounded is best effort: llama.rn cannot interrupt prompt ingestion, and
      // the simulator's CPU prefill outlasts the app's background time, so iOS may suspend the app
      // first (startup recovery covers a later termination; see cold-recovery). The stop still
      // settles the turn, at the latest once the app returns.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await api('/execute/sync', { script: 'mobile: activateApp', args: [{ bundleId }] });
      let stopped;
      await e2e.waitFor(
        'backgrounding stops the active local turn and it settles durably as interrupted',
        async () => {
          stopped = (await loadThreads()).find((entry) => entry.id !== thread.id);
          return stopped?.status === 'interrupted' && stopped.activeTurnId === null;
        },
        { timeoutMs: 180_000, intervalMs: 500 },
      );
      await e2e.waitFor(
        'stop controls settle after foregrounding',
        async () => (await absent(selectors.stop)) && (await absent(selectors.stopping)),
        { timeoutMs: 30_000 },
      );
      await type(selectors.message, 'composer remains available');
      const send = await find(selectors.send);
      await e2e.check('settled run restores composer send availability', () =>
        api(`/element/${send}/enabled`, undefined, 'GET'),
      );
      await capture('on-device-stopped-chat');
    });
    await e2e.phase('switch-profile', async () => {
      await startNewChat();
      await tap(selectors.runTarget);
      await find(selectors.addBridge);
      await e2e.check(
        'the profile switcher offers On this iPhone beside pairing a desktop',
        async () => (await query(selectors.localProfile)).length > 0,
      );
      await capture('on-device-profile-switcher');
      await tap(selectors.addBridge);
      await find(selectors.bridgeUrl);
      await capture('on-device-add-bridge');
      await tap(selectors.cancelConnection);
      // Pairing is anchored on Settings (see profiles/actions.ts), so cancelling lands there.
      await e2e.waitFor(
        'cancelling pairing returns to Settings',
        () => absent(selectors.bridgeUrl),
        {
          timeoutMs: 15_000,
        },
      );
      await find(selectors.settingsModels);
      await startNewChat();
      await e2e.check(
        'leaving and returning keeps the local profile, conversations, and workspace files',
        async () =>
          (await source()).includes(selectors.localProfile) &&
          (await loadThreads()).some((entry) => entry.id === thread.id) &&
          (await fs.readFile(path.join(repository, 'offline.txt'), 'utf8')).trim() ===
            'OFFLINE_PRODUCT_OK',
      );
      await openChat(thread.id);
      await find(selectors.message);
    });
  } catch (error) {
    if (session) {
      try {
        await capture('on-device-failure');
      } catch (captureError) {
        throw new AggregateError(
          [error, captureError],
          'Native product scenario and diagnostic capture failed.',
        );
      }
      if (container) {
        e2e.writeFile('logs/failure-threads.json', JSON.stringify(await loadThreads()));
      }
    }
    throw error;
  } finally {
    try {
      if (session) {
        await api('', undefined, 'DELETE');
      }
    } finally {
      try {
        if (appium) {
          await appium.stop();
        }
      } finally {
        try {
          if (booted) {
            const shutdown = await e2e.run('xcrun', ['simctl', 'shutdown', simulator], {
              expectExitCodes: [0, 149],
            });
            if (shutdown.code === 149) {
              await e2e.expectMatch(
                'simulator was already stopped by the driver',
                shutdown.stderr,
                /current state: Shutdown/,
              );
            }
          }
        } finally {
          if (simulator) {
            await e2e.run('xcrun', ['simctl', 'delete', simulator]);
          }
        }
      }
    }
  }
}
