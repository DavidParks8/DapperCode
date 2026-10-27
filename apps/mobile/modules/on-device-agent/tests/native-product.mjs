import fs from 'node:fs/promises';
import path from 'node:path';
import { bundleNativeReactApp } from './bundleNativeReactApp.mjs';
import catalog from '../../../src/features/on-device/models/catalog.json' with { type: 'json' };
import { nativeOnDeviceSelectors as selectors } from '../../../../../e2e/fixtures/selectors.ts';

export const name = 'on-device-offline-product';
export const contract = {
  requiredPhases: [
    'bundle',
    'prepare',
    'navigate',
    'offline-turn',
    'cold-recovery',
    'stop-background',
    'switch-target',
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
  const find = async (label) => {
    let element;
    await e2e.waitFor(
      `visible native control: ${label}`,
      async () => {
        const elements = await api(
          '/elements',
          label === selectors.message
            ? { using: '-ios predicate string', value: selectors.messagePredicate }
            : { using: 'accessibility id', value: label },
        );
        element = elements.find((entry) => Boolean(entry));
        return Boolean(element);
      },
      { timeoutMs: 30_000, intervalMs: 300 },
    );
    return Object.values(element)[0];
  };
  const tap = async (label) => {
    const element = await find(label);
    await e2e.waitFor(
      `enabled native control: ${label}`,
      () => api(`/element/${element}/enabled`, undefined, 'GET'),
      { timeoutMs: 15_000 },
    );
    return api(`/element/${element}/click`, {});
  };
  const type = async (label, text) => api(`/element/${await find(label)}/value`, { text });
  const source = () => api('/source', undefined, 'GET');
  const capture = async (name) => {
    const screenshot = await api('/screenshot', undefined, 'GET');
    e2e.writeFile(`logs/${name}.png`, Buffer.from(screenshot, 'base64'));
    e2e.writeFile(`logs/${name}.xml`, await source());
  };
  const runtimeRoot = () => path.join(container, 'Library/Application Support/OnDeviceAgent/state');
  const loadThreads = async () => {
    const names = (await fs.readdir(runtimeRoot())).filter((name) => name.startsWith('thread-'));
    return Promise.all(names.map((name) => readJSON(path.join(runtimeRoot(), name))));
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
    await e2e.phase('navigate', async () => {
      const entries = await api('/elements', {
        using: '-ios predicate string',
        value: 'label CONTAINS "On this iPhone"',
      });
      await e2e.check(
        'onboarding exposes explicit iPhone execution choice',
        () => entries.length > 0,
      );
      await api(`/element/${Object.values(entries.at(-1))[0]}/click`, {});
      await find(selectors.modelLibrary);
      await capture('on-device-home');
      await tap(selectors.modelLibrary);
      await e2e.waitFor(
        'RAM-aware downloaded model library',
        async () => (await source()).includes('Recommended'),
        { timeoutMs: 30_000 },
      );
      await capture('on-device-models');
      await e2e.check('model library labels simulator estimates honestly', async () =>
        (await source()).includes('Simulator host estimate'),
      );
      await tap(selectors.back);
      await tap(selectors.workspaces);
      await e2e.check('workspace picker shows the native workspace', async () =>
        (await source()).includes('Offline UI fixture'),
      );
      await capture('on-device-workspaces');
      await tap(selectors.back);
      await tap(selectors.account);
      await e2e.check('unconfigured GitHub sign-in is explicit', async () =>
        (await source()).includes('not configured'),
      );
      await tap(selectors.back);
    });
    await e2e.phase('offline-turn', async () => {
      await tap(selectors.newChat);
      await capture('on-device-empty-chat');
      await type(
        selectors.message,
        'Use write_file to create offline.txt containing exactly OFFLINE_PRODUCT_OK. Then use git_stage for offline.txt and git_commit with message offline fixture. You must use those tools, not describe commands. Report the resulting commit.',
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
      await e2e.check(
        'composer and visible status settle after native generation',
        async () =>
          (await source()).includes('offline ready') && !(await source()).includes('Stop agent'),
      );
      await capture('on-device-chat');
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
        'background draft flush',
        async () =>
          (await readJSON(path.join(runtimeRoot(), 'preferences.json'))).drafts[thread.id] ===
          'durable offline draft',
        { timeoutMs: 30_000 },
      );
      await api('/execute/sync', { script: 'mobile: terminateApp', args: [{ bundleId }] });
      await api('/execute/sync', { script: 'mobile: activateApp', args: [{ bundleId }] });
      await find(selectors.modelLibrary);
      await tap(thread.title);
      const input = await find(selectors.message);
      const value = await api(`/element/${input}/attribute/value`, undefined, 'GET');
      await e2e.expectEqual(
        'cold launch restores the selected target and draft',
        value,
        'durable offline draft',
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
      const injected = e2e.writeFile('data/interrupted-thread.json', JSON.stringify(uncertain));
      await e2e.run('cp', [injected, path.join(runtimeRoot(), `thread-${thread.id}.json`)]);
      await api('/execute/sync', { script: 'mobile: activateApp', args: [{ bundleId }] });
      await find(selectors.modelLibrary);
      await tap(thread.title);
      await e2e.waitFor(
        'uncertain tool recovery warning',
        async () => (await source()).includes('interrupted'),
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
      await tap(selectors.back);
    });
    await e2e.phase('stop-background', async () => {
      await tap(selectors.newChat);
      await type(
        selectors.message,
        'List the numbers from 1 to 10000 separated by commas. Do not stop early.',
      );
      await tap(selectors.send);
      await find('Stop agent');
      await api('/execute/sync', { script: 'mobile: pressButton', args: [{ name: 'home' }] });
      let stopped;
      await e2e.waitFor(
        'background stops and durably settles the active local turn',
        async () => {
          stopped = (await loadThreads()).find((entry) => entry.id !== thread.id);
          return stopped?.status === 'interrupted' && stopped.activeTurnId === null;
        },
        { timeoutMs: 45_000, intervalMs: 500 },
      );
      await api('/execute/sync', { script: 'mobile: activateApp', args: [{ bundleId }] });
      await e2e.waitFor(
        'stop controls settle after foregrounding',
        async () => {
          const xml = await source();
          return (
            xml.includes('completed edits are preserved') &&
            !xml.includes('Stop agent') &&
            !xml.includes('Stopping agent')
          );
        },
        { timeoutMs: 30_000 },
      );
      await type(selectors.message, 'composer remains available');
      const send = await find(selectors.send);
      await e2e.check('settled run restores composer send availability', () =>
        api(`/element/${send}/enabled`, undefined, 'GET'),
      );
      await capture('on-device-stopped-chat');
      await tap(selectors.back);
    });
    await e2e.phase('switch-target', async () => {
      const button = await find('Connect a desktop instead');
      await api(`/element/${button}/click`, {});
      await e2e.waitFor(
        'explicit desktop onboarding',
        async () => (await source()).includes('Private connection'),
        { timeoutMs: 30_000 },
      );
      const rows = await api('/elements', {
        using: '-ios predicate string',
        value: 'label CONTAINS "On this iPhone"',
      });
      await api(`/element/${Object.values(rows.at(-1))[0]}/click`, {});
      await find(selectors.modelLibrary);
      await e2e.check(
        'target switch preserves local conversations and workspace files',
        async () =>
          (await loadThreads()).some((entry) => entry.id === thread.id) &&
          (await fs.readFile(path.join(repository, 'offline.txt'), 'utf8')).trim() ===
            'OFFLINE_PRODUCT_OK',
      );
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
