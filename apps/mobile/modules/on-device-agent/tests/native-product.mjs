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
    'model-download',
    'model-sheet',
    'offline-turn',
    'empty-workspace-git',
    'file-tool-turn',
    'network-tool-approvals',
    'cold-recovery',
    'public-clone-and-chat-push',
    'stop-background',
    'switch-profile',
  ],
};

export default async function scenario(
  e2e,
  { afterModelSheet, autoAcceptAlerts = true, singleModelFamily = false } = {},
) {
  const mobile = path.join(e2e.worktree, 'apps/mobile');
  const sources = path.join(mobile, 'modules/on-device-agent/tests');
  const modelId = process.env.DAPPERCODE_NATIVE_TEST_MODEL ?? 'qwen35-2b-q4-k-m';
  const model = catalog.find((entry) => entry.id === modelId);
  if (!model || model.runtimeIssue) {
    throw new Error('Choose a runnable model from the bundled catalog for native validation.');
  }
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
  let publicOrigin;
  let publicRepository;
  let publicGit;
  let searchOrigin;
  const certificate = path.join(e2e.dataDir, 'public-certificate.pem');
  const privateKey = path.join(e2e.dataDir, 'public-private-key.pem');
  let physicalToolTaps = 0;
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
  const git = (args, options = {}) => e2e.run('git', args, { ...options, env: gitEnvironment });
  const readJSON = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
  const command = async (route, body, method = 'POST') => {
    const result = await e2e.requestHttp({
      url: `${endpoint}${route}`,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      timeoutMs: route === '/session' ? 600_000 : 180_000,
      maxBodyBytes: 8 * 1024 * 1024,
      expectStatus: [200, 404, 500],
    });
    const value = JSON.parse(result.text).value;
    if (result.status !== 200) {
      throw new Error(`WebDriver ${value.error}: ${value.message.slice(0, 500)}`, {
        cause: value,
      });
    }
    return value;
  };
  const api = (route, body, method) => command(`/session/${session}${route}`, body, method);
  const predicate = (selector) =>
    typeof selector === 'string' ? `name == ${JSON.stringify(selector)}` : selector.predicate;
  const query = async (selector, visible = false) => {
    const chain = typeof selector === 'object' && selector.classChain;
    const locator = chain
      ? {
          using: '-ios class chain',
          value: `${chain}${visible ? '[\`visible == true\`]' : ''}`,
        }
      : visible
        ? {
            using: '-ios predicate string',
            value: `(${predicate(selector)}) AND visible == true`,
          }
        : typeof selector === 'string'
          ? { using: 'accessibility id', value: selector }
          : { using: '-ios predicate string', value: selector.predicate };
    const matches = await api('/elements', locator);
    if (!visible || matches.length > 0 || (await query(selector)).length === 0) {
      return matches;
    }
    // WDA can retain stale visibility after a React Native stack transition.
    // A full snapshot refreshes it without changing the app or replaying an action.
    await api('/source', undefined, 'GET');
    return api('/elements', locator);
  };
  const reveal = async (selector) => {
    for (const direction of [...Array(4).fill('up'), ...Array(8).fill('down')]) {
      await dismissIdleReview();
      if ((await query(selector, true)).length > 0) {
        return;
      }
      await api('/execute/sync', {
        script: 'mobile: swipe',
        args: [{ direction }],
      });
    }
    if ((await query(selector, true)).length === 0) {
      throw new Error(`The control could not be revealed: ${describe(selector)}`);
    }
  };
  const describe = (selector) =>
    typeof selector === 'string' ? selector : (selector.predicate ?? selector.classChain);
  const find = async (selector, visible = false) => {
    let element;
    await e2e.waitFor(
      `visible native control: ${describe(selector)}`,
      async () => {
        let matches = await query(selector, visible);
        if (visible && matches.length === 0) {
          await dismissIdleReview();
          matches = await query(selector, visible);
        }
        element = matches.find((entry) => Boolean(entry));
        return Boolean(element);
      },
      { timeoutMs: 30_000, intervalMs: 300 },
    );
    return Object.values(element)[0];
  };
  const absent = async (selector) => (await query(selector)).length === 0;
  const reviewInSnapshot = async () =>
    (await api('/source', undefined, 'GET'))
      .match(/<XCUIElementTypeButton\b[^>]*>/gu)
      ?.some((tag) => tag.includes('name="Not Now"') && tag.includes('visible="true"')) ?? false;
  const dismissIdleReview = async () => {
    if (!(await reviewInSnapshot())) {
      return false;
    }
    const [dialog] = await query(selectors.reviewNotNow, true);
    if (!dialog) {
      return false;
    }
    await e2e.check(
      'automatic review appears only while every local turn and loading control are settled',
      async () =>
        (await loadThreads()).every((entry) => entry.status !== 'running') &&
        (await absent(selectors.stop)) &&
        (await absent(selectors.stopping)),
    );
    await api(`/element/${Object.values(dialog)[0]}/click`, {});
    await e2e.waitFor(
      'the idle review prompt is dismissed before the next user message',
      async () => !(await reviewInSnapshot()),
      { timeoutMs: 15_000 },
    );
    return true;
  };
  // Native stacks retain hidden controls; non-accessible layout wrappers can still be invisible
  // while their children show, so visibility is required for interactions, not structural checks.
  const waitForStableControl = async (element, selector) => {
    await e2e.waitFor(
      `enabled native control: ${describe(selector)}`,
      () => api(`/element/${element}/enabled`, undefined, 'GET'),
      { timeoutMs: 15_000 },
    );
    let previousBounds;
    let stableSamples = 0;
    await e2e.waitFor(
      `native control stops moving: ${describe(selector)}`,
      async () => {
        const bounds = JSON.stringify(await api(`/element/${element}/rect`, undefined, 'GET'));
        stableSamples = bounds === previousBounds ? stableSamples + 1 : 0;
        previousBounds = bounds;
        return stableSamples >= 2;
      },
      { timeoutMs: 10_000, intervalMs: 150 },
    );
  };
  const tap = async (selector, { physical = false } = {}) => {
    await dismissIdleReview();
    await api('/source', undefined, 'GET');
    if ((await query(selector, true)).length === 0 && (await query(selector)).length > 0) {
      await reveal(selector);
    }
    const element = await find(selector, true);
    await waitForStableControl(element, selector);
    if (physical) {
      const ordinal = ++physicalToolTaps;
      await capture(`tool-toggle-before-${ordinal}`);
      const bounds = await api(`/element/${element}/rect`, undefined, 'GET');
      const value = await api(`/element/${element}/attribute/value`, undefined, 'GET');
      await e2e.check(
        'the tool header has a real on-screen touch target',
        () => bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0,
      );
      e2e.emit({ event: 'native-tool-tap', selector: describe(selector), bounds, value });
      const result = await api('/execute/sync', {
        script: 'mobile: tap',
        args: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
      });
      await capture(`tool-toggle-after-${ordinal}`);
      return result;
    }
    return api(`/element/${element}/click`, {});
  };
  const type = async (selector, text) => {
    await dismissIdleReview();
    await api('/source', undefined, 'GET');
    if ((await query(selector, true)).length === 0 && (await query(selector)).length > 0) {
      await reveal(selector);
    }
    let element = await find(selector, true);
    let submitted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!submitted) {
          await waitForStableControl(element, selector);
          await api(`/element/${element}/value`, { text });
          submitted = true;
        }
        await e2e.expectEqual(
          `native input preserves text: ${describe(selector)}`,
          await api(`/element/${element}/attribute/value`, undefined, 'GET'),
          text,
        );
        return;
      } catch (error) {
        if (
          attempt !== 0 ||
          error.cause?.error !== 'stale element reference' ||
          (await query(selectors.reviewNotNow, true)).length === 0
        ) {
          throw error;
        }
        await dismissIdleReview();
        // StoreKit can replace the accessibility tree between lookup and typing.
        // Refind only for this verified idle dialog; never retype acknowledged input.
        element = await find(selector, true);
      }
    }
  };
  const hold = async (selector, duration = 1) =>
    api('/execute/sync', {
      script: 'mobile: touchAndHold',
      args: [{ elementId: await find(selector, true), duration }],
    });
  const swipeLeft = async (selector) =>
    api('/execute/sync', {
      script: 'mobile: swipe',
      args: [{ elementId: await find(selector, true), direction: 'left' }],
    });
  const removeBySwipe = async (selector, removeAction) => {
    await swipeLeft(selector);
    await e2e.waitFor(
      'swipe removes the row or reveals its delete action',
      async () =>
        (await query(selector)).length === 0 || (await query(removeAction, true)).length > 0,
      { timeoutMs: 15_000 },
    );
    if ((await query(removeAction, true)).length > 0) {
      await tap(removeAction);
    }
  };
  const selectedWorkspaceIs = async (name) => {
    const [chip] = await query(selectors.workspace, true);
    return chip
      ? (
          await api(`/element/${Object.values(chip)[0]}/attribute/label`, undefined, 'GET')
        ).endsWith(name)
      : false;
  };
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
  const openDrawer = async () => {
    await dismissIdleReview();
    if ((await query(selectors.newChat, true)).length === 0) {
      await tap(selectors.openDrawer);
    }
    await e2e.waitFor(
      'the navigation drawer opens, including after a verified review interruption',
      async () => {
        if (await dismissIdleReview()) {
          await tap(selectors.openDrawer);
        }
        return (await query(selectors.newChat, true)).length > 0;
      },
      { timeoutMs: 30_000 },
    );
  };
  const openChat = async (id) => {
    await openDrawer();
    await tap(`${selectors.chatRowPrefix}${id}`);
  };
  const startNewChat = async () => {
    await openDrawer();
    await tap(selectors.newChat);
    await e2e.waitFor(
      'New chat closes its overlay before accepting composer input',
      async () => {
        await api('/source', undefined, 'GET');
        return (
          (await query(selectors.newChat, true)).length === 0 &&
          (await query(selectors.runTarget, true)).length > 0
        );
      },
      { timeoutMs: 30_000 },
    );
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
        metroConfig: path.join(sources, 'product.metro.config.mjs'),
      });
      await e2e.check(
        'the isolated product bundle includes its owned network transport',
        async () =>
          (await fs.readFile(path.join(app, 'main.jsbundle'), 'utf8')).includes(
            'X-DapperCode-Fixture-Target',
          ),
      );
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
      publicRepository = path.join(e2e.workspaceDir, 'public-git/remote.git');
      const seedRepository = path.join(e2e.workspaceDir, 'public-git/seed');
      await git(['init', '--bare', '--initial-branch=main', publicRepository]);
      await git(['--git-dir', publicRepository, 'config', 'http.receivepack', 'true']);
      await git(['init', '--initial-branch=main', seedRepository]);
      e2e.writeFile('workspace/public-git/seed/README.md', 'PUBLIC_CLONE_OK\n');
      await git(['-C', seedRepository, 'add', '.']);
      await git([
        '-C',
        seedRepository,
        '-c',
        'user.name=Public fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'public seed',
      ]);
      await git(['-C', seedRepository, 'push', publicRepository, 'main']);
      await e2e.run(
        '/usr/bin/openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
          '-addext',
          'basicConstraints=critical,CA:TRUE',
          '-keyout',
          privateKey,
          '-out',
          certificate,
        ],
        { timeoutMs: 30_000 },
      );
      publicGit = await e2e.start(
        'node',
        [
          path.join(sources, 'git-https-server.mjs'),
          path.join(e2e.workspaceDir, 'public-git'),
          certificate,
          privateKey,
        ],
        {
          label: 'public-git',
          env: {
            ...gitEnvironment,
            NATIVE_GIT_ALLOW_ANONYMOUS: '1',
            NATIVE_GIT_USER: undefined,
            NATIVE_GIT_PASSWORD: undefined,
          },
        },
      );
      const listening = await e2e.waitForLog('public-git', /NATIVE_GIT_PORT=(\d+)/);
      publicOrigin = `https://127.0.0.1:${listening[1]}/remote.git`;
      await e2e.run('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--cacert',
        certificate,
        `${publicOrigin}/info/refs?service=git-upload-pack`,
      ]);
      await e2e.start(
        'node',
        [path.join(sources, 'search-mcp-server.mjs'), certificate, privateKey],
        { label: 'search-fixture' },
      );
      const searchPort = await e2e.waitForLog('search-fixture', /SEARCH_FIXTURE_PORT=(\d+)/);
      searchOrigin = `https://127.0.0.1:${searchPort[1]}`;
      const searchState = await e2e.run('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--cacert',
        certificate,
        `${searchOrigin}/state`,
      ]);
      await e2e.expectEqual(
        'the owned HTTPS search fixture starts without requests',
        JSON.parse(searchState.stdout).requests,
        [],
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
      await e2e.run('xcrun', ['simctl', 'keychain', simulator, 'add-root-cert', certificate]);
      await e2e.run('xcrun', ['simctl', 'install', simulator, app], { timeoutMs: 120_000 });
      const data = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      container = data.stdout.trim();
      const transportConfig = e2e.writeFile(
        'data/product-transport.json',
        JSON.stringify({ searchOrigin, modelDownloads: {} }),
      );
      await e2e.run('cp', [
        transportConfig,
        path.join(container, 'Documents/product-transport.json'),
      ]);
      const modelIdentifier = e2e.writeFile('data/model-id.txt', model.id);
      await e2e.run('cp', [modelIdentifier, path.join(container, 'Documents/model-id.txt')]);
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
            'appium:settings[snapshotMaxDepth]': 80,
            'appium:maxTypingFrequency': 10,
            'appium:wdaLaunchTimeout': 240000,
            'appium:showXcodeLog': true,
            'appium:derivedDataPath': path.join(mobile, 'local-builds', 'on-device-wda'),
            'appium:useNewWDA': true,
            'appium:autoAcceptAlerts': autoAcceptAlerts,
          },
        },
      });
      session = createdSession.sessionId;
      const settings = await api('/appium/settings', undefined, 'GET');
      await e2e.expectEqual(
        'native snapshots include deeply nested gesture rows',
        settings.snapshotMaxDepth,
        80,
      );
      await e2e.check(
        'native fixture prepares its workspace in a disposable simulator container',
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
      await e2e.check(
        'the setup guide requires a model while recognizing the prepared workspace and author',
        async () => {
          const xml = await source();
          return (
            !(await absent(selectors.setupGuide)) &&
            xml.includes('1. Download a model') &&
            !xml.includes('1. Download a model, Done') &&
            xml.includes('2. Clone or create a workspace, Done') &&
            xml.includes('3. Add a Git author, Done')
          );
        },
      );
      await e2e.expectEqual(
        'the first-run model requirement appears once, not above and below the workspace',
        (
          await query(
            {
              predicate: `type == "XCUIElementTypeStaticText" AND accessible == true AND label == ${JSON.stringify(`Download ${model.name} ${model.quantization} to start a conversation.`)}`,
            },
            true,
          )
        ).length,
        1,
      );
      await capture('on-device-new-chat');
    });
    await e2e.phase('settings', async () => {
      await openDrawer();
      await tap(selectors.settings);
      await tap(selectors.settingsModels);
      await find(selectors.modelLibrary);
      await find(
        singleModelFamily
          ? selectors.modelFamily(model.family.toLowerCase().replaceAll(' ', '-'))
          : selectors.qwen35Family,
      );
      await capture('on-device-models');
      await e2e.check(
        'the model library lists modern families without inline quant actions',
        async () => {
          const xml = await source();
          return (
            (singleModelFamily
              ? xml.includes(model.family)
              : xml.includes('Bonsai 2') && xml.includes('Qwen3.5') && xml.includes('Gemma 4')) &&
            !xml.includes('Load and use')
          );
        },
      );
      await e2e.check('the model library labels simulator memory as an estimate', async () =>
        (await source()).includes('simulator estimate'),
      );
      await type(selectors.modelSearch, 'NO_SUCH_LOCAL_MODEL');
      await e2e.check('model search exposes its empty state', async () =>
        (await source()).includes('No models match'),
      );
      await api(`/element/${await find(selectors.modelSearch, true)}/clear`, {});
      await api('/appium/device/hide_keyboard', {});
      await tap(selectors.downloadedOnly);
      await e2e.check('downloaded-only filter is empty before the first download', async () =>
        (await source()).includes('No models match'),
      );
      await tap(selectors.downloadedOnly);
      await tap(selectors.includeLargeModels);
      await e2e.check(
        'including large models keeps supported families browsable',
        async () =>
          (
            await query(
              singleModelFamily
                ? selectors.modelFamily(model.family.toLowerCase().replaceAll(' ', '-'))
                : selectors.gemmaFamily,
            )
          ).length > 0,
      );
      await tap(selectors.includeLargeModels);
      if (!singleModelFamily) {
        await reveal(selectors.qwen35Family);
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
      }
      await back(selectors.modelLibrary);
      await tap(selectors.gitAccount);
      await find(selectors.gitAccountPage);
      await e2e.check('unconfigured GitHub sign-in is explicit', async () =>
        Boolean(await find(selectors.githubUnavailable)),
      );
      await api(`/element/${await find(selectors.gitAuthorName, true)}/clear`, {});
      await e2e.check('an empty Git author cannot be saved', async () => {
        const save = await find(selectors.gitAuthorSave, true);
        return !(await api(`/element/${save}/enabled`, undefined, 'GET'));
      });
      await type(selectors.gitAuthorName, 'Offline UI Updated');
      await api(`/element/${await find(selectors.gitAuthorEmail, true)}/clear`, {});
      await type(selectors.gitAuthorEmail, 'invalid');
      await e2e.check('an invalid Git email cannot be saved', async () => {
        const save = await find(selectors.gitAuthorSave, true);
        return !(await api(`/element/${save}/enabled`, undefined, 'GET'));
      });
      await api(`/element/${await find(selectors.gitAuthorEmail, true)}/clear`, {});
      await type(selectors.gitAuthorEmail, 'fixture@example.invalid');
      await tap(selectors.gitAuthorSave);
      await e2e.waitFor(
        'Git author settings save through the production account page',
        async () => (await source()).includes('Commit author saved.'),
        { timeoutMs: 30_000 },
      );
      await capture('on-device-git-account');
      await back(selectors.gitAccountPage);
      await startNewChat();
    });
    await e2e.phase('model-download', async () => {
      await openDrawer();
      await tap(selectors.settings);
      await tap(selectors.settingsModels);
      await tap(selectors.modelFamily(model.family.toLowerCase().replaceAll(' ', '-')));
      await reveal(selectors.modelDownload(model.id));
      await tap(selectors.modelDownload(model.id));
      await e2e.waitFor(
        'app-driven model download and checksum verification expose the Load action',
        async () => (await query(selectors.modelLoad(model.id))).length > 0,
        { timeoutMs: 900_000, intervalMs: 1000 },
      );
      await e2e.check('the downloaded model is verified and available to load', () =>
        absent(selectors.modelDownload(model.id)),
      );
      await reveal(selectors.modelLoad(model.id));
      await tap(selectors.modelLoad(model.id));
      await e2e.waitFor(
        'loading the verified model exposes the Unload action',
        async () => (await query(selectors.modelUnload(model.id))).length > 0,
        { timeoutMs: 180_000, intervalMs: 1000 },
      );
      await e2e.check(
        'the model is resident after a real Settings load',
        async () => (await query(selectors.modelUnload(model.id))).length > 0,
      );
      await reveal(selectors.modelUnload(model.id));
      await tap(selectors.modelUnload(model.id));
      await e2e.waitFor(
        'explicit unload leaves verified weights ready to load again',
        async () => (await query(selectors.modelLoad(model.id))).length > 0,
        { timeoutMs: 60_000 },
      );
      await reveal(selectors.modelLoad(model.id));
      await tap(selectors.modelLoad(model.id));
      await e2e.waitFor(
        'the same model can be reloaded after explicit unload',
        async () => (await query(selectors.modelUnload(model.id))).length > 0,
        { timeoutMs: 180_000 },
      );
      await capture('on-device-downloaded-model');
      await back(selectors.familyPage);
      await back(selectors.modelLibrary);
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
        (await source()).includes(model.name),
      );
      await capture('on-device-model-sheet');
      await tap(selectors.sheetClose);
      await e2e.waitFor('model sheet closes', () => absent(selectors.downloadMoreModels), {
        timeoutMs: 15_000,
      });
    });
    if (afterModelSheet) {
      await afterModelSheet({
        model,
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
        git,
        hold,
        swipeLeft,
        publicOrigin,
        publicGit,
        source,
      });
      return;
    }
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
      const author = await git(['-C', repository, 'log', '-1', '--format=%an <%ae>']);
      await e2e.expectEqual(
        'chat commits use the author saved through Settings',
        author.stdout.trim(),
        'Offline UI Updated <fixture@example.invalid>',
      );
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
    await e2e.phase('empty-workspace-git', async () => {
      const originalThreadId = thread.id;
      const existingThreads = new Set((await loadThreads()).map((entry) => entry.id));
      await startNewChat();
      await tap(selectors.workspace);
      await tap(selectors.newWorkspace);
      await type(selectors.workspaceCreateInput, 'Empty UI fixture');
      await tap(selectors.workspaceCreateSubmit);
      await e2e.waitFor(
        'app-created empty workspace is selected for the new chat',
        () => selectedWorkspaceIs('Empty UI fixture'),
        { timeoutMs: 30_000 },
      );
      await type(
        selectors.message,
        "List the root directory with list_directory using path ''. Report whether it is empty. Do not create or change anything.",
      );
      await tap(selectors.send);
      let emptyThread;
      await e2e.waitFor(
        'empty-workspace chat settles before opening Git',
        async () => {
          emptyThread = (await loadThreads()).find((entry) => !existingThreads.has(entry.id));
          return emptyThread && ['complete', 'failed', 'interrupted'].includes(emptyThread.status);
        },
        { timeoutMs: 900_000, intervalMs: 1000 },
      );
      await e2e.expectEqual('empty-workspace turn completes', emptyThread.status, 'complete');
      const emptyRepository = path.join(
        container,
        'Library/Application Support/OnDeviceAgent/workspaces',
        emptyThread.workspaceId,
        'repository',
      );
      await e2e.expectEqual(
        'the workspace created in the app is genuinely empty before initialization',
        await fs.readdir(emptyRepository),
        [],
      );
      await tap(selectors.openGit);
      await find(selectors.gitSetup);
      await capture('on-device-empty-git');
      await type(selectors.gitOrigin, 'ssh://example.invalid/repository.git');
      await e2e.check('Git initialization rejects a non-HTTPS origin', async () => {
        const element = await find(selectors.gitInitialize);
        return !(await api(`/element/${element}/enabled`, undefined, 'GET'));
      });
      await api(`/element/${await find(selectors.gitOrigin)}/clear`, {});
      await api('/appium/device/hide_keyboard', {});
      await tap(selectors.gitInitialize);
      await e2e.waitFor(
        'Git initialization replaces the setup card with a clean unborn repository',
        async () =>
          (await absent(selectors.gitSetup)) && (await source()).includes('Working tree clean'),
        { timeoutMs: 30_000 },
      );
      const branch = await git(['-C', emptyRepository, 'symbolic-ref', '--short', 'HEAD']);
      await e2e.check('app initialization creates a native initial branch', () =>
        Boolean(branch.stdout.trim()),
      );
      await tap(selectors.browseFiles);
      await find(selectors.filesScreen);
      await tap(selectors.filesNew);
      await type(selectors.filesCreateInput, 'hello.txt');
      await tap(selectors.filesCreateSubmit);
      await type(selectors.filesEditor, 'DO_NOT_SAVE');
      await find(selectors.filesDirty);
      await tap(selectors.filesBack);
      await find(selectors.filesUnsaved);
      await e2e.expectEqual(
        'dirty-file navigation does not silently write the draft',
        await fs.readFile(path.join(emptyRepository, 'hello.txt'), 'utf8'),
        '',
      );
      await tap(selectors.filesDiscardEdits);
      await e2e.waitFor(
        'discarding the draft clears its dirty marker',
        () => absent(selectors.filesDirty),
        {
          timeoutMs: 30_000,
        },
      );
      await type(selectors.filesEditor, 'EMPTY_WORKSPACE_OK');
      await tap(selectors.filesSave);
      await e2e.waitFor(
        'file save clears its dirty indicator',
        () => absent(selectors.filesDirty),
        {
          timeoutMs: 30_000,
        },
      );
      await e2e.expectEqual(
        'Files editor writes the newly initialized workspace, not another workspace',
        await fs.readFile(path.join(emptyRepository, 'hello.txt'), 'utf8'),
        'EMPTY_WORKSPACE_OK',
      );
      await tap(selectors.filesBack);
      await tap(selectors.filesNew);
      await type(selectors.filesCreateInput, 'temporary.txt');
      await tap(selectors.filesCreateSubmit);
      await type(selectors.filesEditor, 'TEMPORARY_UI_FILE');
      await tap(selectors.filesSave);
      await e2e.waitFor('temporary file save settles', () => absent(selectors.filesDirty), {
        timeoutMs: 30_000,
      });
      await tap(selectors.filesBack);
      await hold(selectors.fileOpen('temporary.txt'));
      await api(`/element/${await find(selectors.filesRenameInput, true)}/clear`, {});
      await type(selectors.filesRenameInput, 'renamed-ui.txt');
      await tap(selectors.filesRenameSubmit);
      await find(selectors.fileOpen('renamed-ui.txt'), true);
      await e2e.expectEqual(
        'file rename preserves its native contents',
        await fs.readFile(path.join(emptyRepository, 'renamed-ui.txt'), 'utf8'),
        'TEMPORARY_UI_FILE',
      );
      await removeBySwipe(
        selectors.fileOpen('renamed-ui.txt'),
        selectors.fileDelete('renamed-ui.txt'),
      );
      await e2e.waitFor(
        'full swipe deletes only the temporary file',
        async () => !(await fs.readdir(emptyRepository)).includes('renamed-ui.txt'),
        { timeoutMs: 30_000 },
      );
      await e2e.expectEqual(
        'deleting a different file preserves the first editor file',
        await fs.readFile(path.join(emptyRepository, 'hello.txt'), 'utf8'),
        'EMPTY_WORKSPACE_OK',
      );
      await tap(selectors.filesBack);
      await tap(selectors.gitRefresh);
      await reveal(selectors.gitStageAll);
      await tap(selectors.gitStageAll);
      await tap(selectors.gitUnstageAll);
      const unstaged = await git(['-C', emptyRepository, 'diff', '--cached', '--name-only']);
      await e2e.expectEqual(
        'Unstage all empties the native index before the first commit',
        unstaged.stdout,
        '',
      );
      await tap(selectors.gitStageAll);
      await find(selectors.gitUnstageAll);
      await reveal(selectors.gitCommitMessage);
      await api(`/element/${await find(selectors.gitCommitMessage, true)}/clear`, {});
      await type(selectors.gitCommitMessage, 'empty workspace first commit');
      await tap(selectors.gitCommit);
      await e2e.waitFor(
        'first commit settles and leaves a clean initialized repository',
        async () => (await source()).includes('Working tree clean'),
        { timeoutMs: 30_000 },
      );
      const committed = await git(['-C', emptyRepository, 'show', 'HEAD:hello.txt']);
      await e2e.expectEqual(
        'first native UI commit contains exactly the editor bytes',
        committed.stdout,
        'EMPTY_WORKSPACE_OK',
      );
      const subject = await git(['-C', emptyRepository, 'log', '-1', '--format=%s']);
      await e2e.expectEqual(
        'the first UI commit uses the message entered by the user',
        subject.stdout.trim(),
        'empty workspace first commit',
      );
      await reveal(selectors.gitChangeBranch);
      await tap(selectors.gitChangeBranch);
      await type(selectors.gitNewBranch, 'ui-check');
      await tap(selectors.gitCreateBranch);
      await e2e.waitFor(
        'creating a branch switches the actual repository to it',
        async () =>
          (await git(['-C', emptyRepository, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim() ===
          'ui-check',
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      await api('/appium/device/hide_keyboard', {});
      await tap(selectors.gitBranch(branch.stdout.trim()));
      await find(selectors.gitSelectedBranch(branch.stdout.trim()), true);
      await git([
        '-C',
        emptyRepository,
        '-c',
        'user.name=Native QA',
        '-c',
        'user.email=native-qa@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--allow-empty',
        '--no-gpg-sign',
        '-m',
        'native branch poll preservation',
      ]);
      await e2e.waitFor(
        'the real maintenance poll observes an external fixture commit',
        async () => (await source()).includes('native branch poll preservation'),
        { timeoutMs: 45_000, intervalMs: 500 },
      );
      await e2e.check(
        'the maintenance poll keeps the explicit different branch selected',
        async () =>
          (await query(selectors.gitSelectedBranch(branch.stdout.trim()), true)).length > 0,
      );
      await reveal(selectors.gitSwitchBranch);
      await tap(selectors.gitSwitchBranch);
      await e2e.waitFor(
        'branch switching returns to the original branch',
        async () =>
          (await git(['-C', emptyRepository, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim() ===
          branch.stdout.trim(),
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      const preview = e2e.writeFile('data/large-preview.txt', 'L'.repeat(70 * 1024));
      await e2e.run('cp', [preview, path.join(emptyRepository, 'large-preview.txt')]);
      await tap(selectors.browseFiles);
      await find(selectors.filesNew, true);
      await tap(selectors.filesRefresh);
      await tap(selectors.fileOpen('large-preview.txt'));
      await find(selectors.filesReadOnly);
      await e2e.expectEqual(
        'large file preview is bounded to 64 KiB on the real device screen',
        (
          await api(
            `/element/${await find(selectors.filesEditor, true)}/attribute/value`,
            undefined,
            'GET',
          )
        ).length,
        64 * 1024,
      );
      await e2e.check('a read-only preview cannot be saved', async () => {
        const save = await find(selectors.filesSave, true);
        return !(await api(`/element/${save}/enabled`, undefined, 'GET'));
      });
      await tap(selectors.filesBack);
      await tap(selectors.filesBack);
      await e2e.run('rm', [path.join(emptyRepository, 'large-preview.txt')]);
      await tap(selectors.gitRefresh);
      await e2e.waitFor(
        'preview fixture cleanup restores a clean working tree',
        async () => (await source()).includes('Working tree clean'),
        {
          timeoutMs: 30_000,
        },
      );
      await capture('on-device-initial-commit');
      await tap(selectors.gitBack);
      await startNewChat();
      await tap(selectors.workspace);
      await hold(selectors.workspaceRow('Empty UI fixture'));
      await tap(selectors.renameAction);
      await api(`/element/${await find(selectors.workspaceRenameInput, true)}/clear`, {});
      await type(selectors.workspaceRenameInput, 'Renamed UI fixture');
      await tap(selectors.workspaceRenameSubmit);
      await find(selectors.workspaceRow('Renamed UI fixture'), true);
      await tap(selectors.workspaceDone);
      await e2e.waitFor(
        'workspace rename repairs the new-chat default path',
        () => selectedWorkspaceIs('Renamed UI fixture'),
        { timeoutMs: 30_000 },
      );
      await openChat(emptyThread.id);
      await tap(selectors.openGit);
      await e2e.waitFor(
        'an existing conversation resolves its renamed workspace without losing Git',
        async () =>
          (await source()).includes('Renamed UI fixture') &&
          (await source()).includes('Working tree clean'),
        { timeoutMs: 30_000 },
      );
      await tap(selectors.gitBack);
      await startNewChat();
      await tap(selectors.workspace);
      const beforeDelete = (await loadThreads()).find((entry) => entry.id === emptyThread.id);
      await removeBySwipe(
        selectors.workspaceRow('Renamed UI fixture'),
        selectors.workspaceDelete('Renamed UI fixture'),
      );
      await e2e.waitFor(
        'workspace deletion removes its row and native directory',
        async () => (await query(selectors.workspaceRow('Renamed UI fixture'))).length === 0,
        { timeoutMs: 30_000 },
      );
      await e2e.run('test', ['!', '-e', emptyRepository]);
      await tap(selectors.workspaceDone);
      await openChat(emptyThread.id);
      const preserved = (await loadThreads()).find((entry) => entry.id === emptyThread.id);
      await e2e.expectEqual(
        'deleting a workspace preserves its conversation history',
        preserved?.messages,
        beforeDelete.messages,
      );
      await startNewChat();
      await e2e.waitFor(
        'deleted default workspace falls back to the remaining workspace',
        () => selectedWorkspaceIs('Offline UI fixture'),
        { timeoutMs: 30_000 },
      );
      const workspaceReady = async () => {
        const target = await find(selectors.runTarget, true);
        const label = await api(`/element/${target}/attribute/label`, undefined, 'GET');
        return !/needs (?:a )?workspace/iu.test(label);
      };
      await e2e.waitFor('new-chat readiness agrees with the repaired workspace', workspaceReady, {
        timeoutMs: 30_000,
      });
      await e2e.check(
        'a valid fallback workspace is not shown as a missing prerequisite',
        workspaceReady,
      );
      await openChat(originalThreadId);
      await find(selectors.message);
    });
    await e2e.phase('file-tool-turn', async () => {
      const previousMessages = thread.messages.length;
      const threadId = thread.id;
      const originalFile = await fs.readFile(path.join(repository, 'offline.txt'), 'utf8');
      await type(
        selectors.message,
        "Use the workspace tools to do each step in order: list the root directory (path ''), read seed.txt and offline.txt, create scratch.txt with exactly LOCAL_TOOL_CREATE_OK, read scratch.txt, edit its exact text to LOCAL_TOOL_EDIT_OK using its read revision, rename it to renamed.txt, read renamed.txt, search the workspace for LOCAL_TOOL_EDIT_OK, then delete renamed.txt using its read revision. Finally read Git status, diff, and recent history. Do not stage, commit, or push. Report the seed file's contents and what you did.",
      );
      await tap(selectors.send);
      await e2e.waitFor(
        'complete real-model file and Git inspection sequence',
        async () => {
          thread = (await loadThreads()).find((entry) => entry.id === threadId);
          return (
            thread?.messages.length > previousMessages &&
            ['complete', 'failed', 'interrupted'].includes(thread.status)
          );
        },
        { timeoutMs: 900_000, intervalMs: 1000 },
      );
      await e2e.check('all file and Git inspection tools actually completed through chat', () => {
        if (thread.status !== 'complete') {
          throw new Error(thread.lastError);
        }
        const messages = thread.messages.slice(previousMessages);
        const expected = [
          'list_directory',
          'read_file',
          'write_file',
          'edit_file',
          'rename_path',
          'search_files',
          'delete_path',
          'git_status',
          'git_diff',
          'git_history',
        ];
        const missing = expected.filter(
          (name) =>
            !messages.some(
              (entry) => entry.tool?.name === name && entry.tool.status === 'completed',
            ),
        );
        if (missing.length) {
          throw new Error(
            `The model did not complete these requested tools: ${missing.join(', ')}`,
          );
        }
        return true;
      });
      const renamedRead = thread.messages
        .slice(previousMessages)
        .filter((entry) => entry.tool?.name === 'read_file' && entry.tool.status === 'completed')
        .map((entry) => JSON.parse(entry.content))
        .find((result) => result.path === 'renamed.txt');
      await e2e.expectEqual(
        'reading the renamed file proves the exact requested edit took effect',
        renamedRead?.content,
        'LOCAL_TOOL_EDIT_OK',
      );
      await e2e.expectEqual(
        'model rename and deletion removed only the scratch files',
        (await fs.readdir(repository)).filter((name) =>
          ['scratch.txt', 'renamed.txt'].includes(name),
        ),
        [],
      );
      await e2e.expectEqual(
        'the committed file is unchanged by the inspection turn',
        await fs.readFile(path.join(repository, 'offline.txt'), 'utf8'),
        originalFile,
      );
      const status = await git(['-C', repository, 'status', '--porcelain']);
      await e2e.expectEqual(
        'chat file lifecycle leaves the original repository clean',
        status.stdout,
        '',
      );
      await e2e.waitFor(
        'the composer settles after the multi-tool turn',
        async () => (await absent(selectors.stop)) && (await absent(selectors.stopping)),
        { timeoutMs: 30_000 },
      );
      await capture('on-device-file-tools');
    });
    await e2e.phase('network-tool-approvals', async () => {
      for (const [tool, request] of [
        ['git_push', 'Call git_push now to request my approval to push.'],
        ['web_fetch', 'Call web_fetch for https://example.com/ to request my approval.'],
        [
          'web_search',
          'Call web_search with the public query "IANA Example Domain" to request my approval.',
        ],
      ]) {
        const previousMessages = thread.messages.length;
        const threadId = thread.id;
        await type(
          selectors.message,
          `${request} Do not inspect anything first. If I deny approval, explain that nothing ran and stop. Do not retry or call another tool.`,
        );
        await tap(selectors.send);
        await e2e.waitFor(
          `${tool} presents its real user approval`,
          async () => (await query(selectors.approvalDeny)).length > 0,
          { timeoutMs: 300_000, intervalMs: 1000 },
        );
        const waiting = (await loadThreads()).find((entry) => entry.id === threadId);
        await e2e.check(
          `${tool} approval is not covered by an automatic review`,
          async () => (await query(selectors.reviewNotNow, true)).length === 0,
        );
        await e2e.check(`${tool} waits in the transcript before network execution`, () =>
          waiting.messages
            .slice(previousMessages)
            .some((entry) => entry.tool?.name === tool && entry.tool.status !== 'completed'),
        );
        if (tool === 'git_push') {
          for (const [value, visible] of [
            ['0', false],
            ['1', true],
          ]) {
            await openDrawer();
            await tap(selectors.settings);
            await reveal(selectors.showToolCalls);
            await tap(selectors.showToolCalls);
            await e2e.expectEqual(
              'Settings saves the chosen tool visibility',
              await api(
                `/element/${await find(selectors.showToolCalls, true)}/attribute/value`,
                undefined,
                'GET',
              ),
              value,
            );
            await openChat(threadId);
            await e2e.waitFor(
              'live tool rows follow the actual Settings choice',
              async () => (await query(selectors.toolRows, true)).length > 0 === visible,
              { timeoutMs: 15_000 },
            );
            await e2e.check(
              'hiding tools neither hides nor answers the pending approval',
              async () => (await query(selectors.approvalDeny, true)).length > 0,
            );
          }
        }
        await tap(selectors.approvalDeny);
        await e2e.waitFor(
          `${tool} denial settles the real chat turn`,
          async () => {
            thread = (await loadThreads()).find((entry) => entry.id === threadId);
            return (
              thread.messages.length > previousMessages &&
              ['complete', 'failed', 'interrupted'].includes(thread.status)
            );
          },
          { timeoutMs: 300_000, intervalMs: 1000 },
        );
        await e2e.check(`${tool} records denial, not a successful network operation`, () =>
          thread.messages
            .slice(previousMessages)
            .some((entry) => entry.tool?.name === tool && entry.tool.status === 'failed'),
        );
        if (tool === 'git_push') {
          await e2e.check(
            'the denied push is never mislabeled as a failed fetch',
            async () => (await query(selectors.gitPushFailed, true)).length > 0,
          );
          await tap(selectors.gitPushFailed, { physical: true });
          await e2e.waitFor(
            'expanding a denied tool reveals its actual result',
            async () => (await query(selectors.declinedToolOutput, true)).length > 0,
            { timeoutMs: 15_000 },
          );
          await e2e.check(
            'tool details explain that the denied operation never ran',
            async () => (await query(selectors.declinedToolOutput, true)).length > 0,
          );
          const label = await api(
            `/element/${await find(selectors.declinedToolOutput, true)}/attribute/label`,
            undefined,
            'GET',
          );
          await e2e.expectEqual(
            'one durable denied result is rendered exactly once',
            (label.match(/The user declined this request/gu) ?? []).length,
            1,
          );
          await tap(selectors.gitPushFailed, { physical: true });
          await e2e.waitFor(
            'the tool result collapses again',
            () => absent(selectors.declinedToolOutput),
            { timeoutMs: 15_000 },
          );
        }
        await e2e.waitFor(
          `${tool} approval and stop controls clear after denial`,
          async () =>
            (await absent(selectors.approvalDeny)) &&
            (await absent(selectors.stop)) &&
            (await absent(selectors.stopping)),
          { timeoutMs: 30_000 },
        );
      }
      const deniedSearch = await e2e.run('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--cacert',
        certificate,
        `${searchOrigin}/state`,
      ]);
      await e2e.expectEqual(
        'denied web searches never reach the owned network transport',
        JSON.parse(deniedSearch.stdout).requests.length,
        0,
      );
      for (const [tool, request] of [
        ['web_fetch', 'Use web_fetch to read https://example.com/ and tell me its title.'],
        [
          'web_search',
          'Use web_search for the public query "IANA Example Domain" and cite the source URLs.',
        ],
      ]) {
        const previousMessages = thread.messages.length;
        const threadId = thread.id;
        await type(
          selectors.message,
          `${request} I will answer the approval. Make only one request.`,
        );
        await tap(selectors.send);
        await e2e.waitFor(
          `${tool} presents approval for a real public network operation`,
          async () => (await query(selectors.approvalAllow, true)).length > 0,
          { timeoutMs: 300_000, intervalMs: 1000 },
        );
        await tap(selectors.approvalAllow);
        await e2e.waitFor(
          `${tool} completes its public network operation`,
          async () => {
            thread = (await loadThreads()).find((entry) => entry.id === threadId);
            return (
              thread.messages.length > previousMessages &&
              ['complete', 'failed', 'interrupted'].includes(thread.status)
            );
          },
          { timeoutMs: 300_000, intervalMs: 1000 },
        );
        await e2e.check(`${tool} consumes a genuine network result through chat`, () => {
          const result = thread.messages
            .slice(previousMessages)
            .find((entry) => entry.tool?.name === tool);
          if (result?.tool?.status !== 'completed') {
            throw new Error(result?.content ?? `The model did not execute ${tool}.`);
          }
          return /example\.com|iana\.org/iu.test(result.content);
        });
        if (tool === 'web_search') {
          const recorded = await e2e.run('curl', [
            '--fail',
            '--silent',
            '--show-error',
            '--max-time',
            '10',
            '--cacert',
            certificate,
            `${searchOrigin}/state`,
          ]);
          const requests = JSON.parse(recorded.stdout).requests;
          await e2e.expectEqual(
            'one approved search executes one actual HTTPS MCP request',
            requests.length,
            1,
          );
          const result = thread.messages
            .slice(previousMessages)
            .find((entry) => entry.tool?.name === tool && entry.tool.status === 'completed');
          await e2e.expectEqual(
            'the production search parser consumes its exact network query',
            JSON.parse(result.content).query,
            requests[0].query,
          );
          await e2e.expectEqual(
            'the fixture preserves the production public provider destination',
            requests[0].target,
            'https://mcp.exa.ai/mcp',
          );
        }
      }
      await capture('on-device-network-tools');
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
    await e2e.phase('public-clone-and-chat-push', async () => {
      const originalThreadId = thread.id;
      const existingThreads = new Set((await loadThreads()).map((entry) => entry.id));
      await startNewChat();
      await tap(selectors.workspace);
      await tap(selectors.cloneRepository);
      await type(selectors.cloneUrl, publicOrigin);
      await tap(selectors.cloneRepository);
      await e2e.waitFor(
        'public HTTPS clone publishes and selects its workspace without signing in',
        () => selectedWorkspaceIs('remote'),
        { timeoutMs: 90_000, intervalMs: 500 },
      );
      await type(
        selectors.message,
        'Create remote-proof.txt with the single line LOCAL_PUSH_OK (a trailing newline is optional). Stage that file, commit with message public fixture push, and call git_push. Use tools, not shell commands. I will answer the push approval.',
      );
      await tap(selectors.send);
      await e2e.waitFor(
        'the model writes and commits before requesting push approval',
        async () => (await query(selectors.approvalAllow, true)).length > 0,
        { timeoutMs: 900_000, intervalMs: 1000 },
      );
      const unpublished = await git(
        ['--git-dir', publicRepository, 'show', 'HEAD:remote-proof.txt'],
        { expectExitCodes: [0, 128] },
      );
      await e2e.expectEqual(
        'the remote has not received the file before push approval',
        unpublished.code,
        128,
      );
      await tap(selectors.approvalAllow);
      let pushedThread;
      await e2e.waitFor(
        'approved model push settles through the production local runtime',
        async () => {
          pushedThread = (await loadThreads()).find((entry) => !existingThreads.has(entry.id));
          return (
            pushedThread && ['complete', 'failed', 'interrupted'].includes(pushedThread.status)
          );
        },
        { timeoutMs: 300_000, intervalMs: 1000 },
      );
      await e2e.check('the real git_push tool completed after approval', () => {
        const push = pushedThread.messages.find((entry) => entry.tool?.name === 'git_push');
        if (push?.tool?.status !== 'completed') {
          throw new Error(push?.content ?? 'The model did not execute git_push.');
        }
        return pushedThread.status === 'complete';
      });
      const remoteFile = await git([
        '--git-dir',
        publicRepository,
        'show',
        'HEAD:remote-proof.txt',
      ]);
      await e2e.expectEqual(
        'the isolated remote contains the actual chat-written committed file',
        remoteFile.stdout.trim(),
        'LOCAL_PUSH_OK',
      );
      await tap(selectors.openGit);
      await reveal(selectors.gitFetch);
      await tap(selectors.gitFetch);
      await e2e.waitFor(
        'manual Fetch settles on the cloned public origin',
        async () => (await source()).includes('Fetched the latest changes from origin.'),
        { timeoutMs: 60_000 },
      );
      await tap(selectors.gitPull);
      await e2e.waitFor(
        'manual Pull reports an up-to-date origin without authentication',
        async () => (await source()).includes('Already up to date.'),
        { timeoutMs: 60_000 },
      );
      await capture('on-device-public-git');
      await tap(selectors.gitBack);
      await openChat(originalThreadId);
      await find(selectors.message);
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
      let interruptedThreadId;
      await e2e.waitFor(
        'the local turn is journaled and running',
        async () => {
          const running = (await loadThreads()).find(
            (entry) => entry.id !== thread.id && entry.status === 'running',
          );
          interruptedThreadId = running?.id;
          return Boolean(interruptedThreadId);
        },
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
          stopped = (await loadThreads()).find((entry) => entry.id === interruptedThreadId);
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
    if (!session && booted) {
      try {
        await e2e.run('xcrun', [
          'simctl',
          'io',
          simulator,
          'screenshot',
          path.join(e2e.logDir, 'startup-failure.png'),
        ]);
      } catch (captureError) {
        throw new AggregateError(
          [error, captureError],
          'Native startup and diagnostic capture failed.',
        );
      }
    }
    if (session) {
      try {
        const beforeSnapshot = await query(selectors.modelSearch, true);
        const byIdentifier = await query(selectors.modelSearch);
        await source();
        const afterSnapshot = await query(selectors.modelSearch, true);
        e2e.writeFile(
          'logs/failure-locator-comparison.json',
          JSON.stringify({ beforeSnapshot, byIdentifier, afterSnapshot }),
        );
        await capture('on-device-failure');
      } catch (captureError) {
        throw new AggregateError(
          [error, captureError],
          'Native product scenario and diagnostic capture failed.',
        );
      }
      if (container) {
        e2e.writeFile('logs/failure-threads.json', JSON.stringify(await loadThreads()));
        const documents = path.join(container, 'Documents');
        if ((await fs.readdir(documents)).includes('product-navigation.json')) {
          e2e.writeFile(
            'logs/failure-navigation.json',
            await fs.readFile(path.join(documents, 'product-navigation.json'), 'utf8'),
          );
        }
        if ((await fs.readdir(documents)).includes('product-shell.json')) {
          e2e.writeFile(
            'logs/failure-shell.json',
            await fs.readFile(path.join(documents, 'product-shell.json'), 'utf8'),
          );
        }
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
