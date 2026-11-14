import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const name = 'native-new-chat';
export const contract = { requiredPhases: ['setup', 'iphone', 'duo'] };

export default async function scenario(e2e) {
  const bundleId = 'com.dappermagna.tethercode';
  const output = path.dirname(new URL(import.meta.url).pathname);
  const builtApp = path.join(e2e.worktree, 'apps/mobile/ios/build/Build/Products/Release-iphonesimulator/DapperCode.app');
  const token = e2e.createSecret();
  const agentId = 'local-primary';
  const threadId = `v1.${Buffer.from(agentId).toString('base64url')}.${Buffer.from('thread-layout').toString('base64url')}`;
  const appiumSource = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent/tests/appium-server.mjs');
  const { createDefaultScenario } = await import(pathToFileURL(path.join(e2e.worktree, 'e2e/harness/scenario.ts')));
  let appiumUrl;
  let bridgeUrl;
  let appium;
  let bridge;
  let sessionId;
  let simulator;
  let source = '';
  const leases = [];

  async function request(endpoint, method = 'GET', body) {
    const response = await e2e.requestHttp({
      url: `${appiumUrl}${endpoint}`, method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 240000, maxBodyBytes: 16 * 1024 * 1024, expectStatus: [200, 400, 404, 500],
    });
    const result = JSON.parse(response.text);
    if (response.status !== 200 || result.value?.error) {
      throw new Error(`Appium ${endpoint}: ${e2e.redact(JSON.stringify(result.value))}`);
    }
    return result.value;
  }
  const api = (endpoint, method = 'GET', body) => request(`/session/${sessionId}${endpoint}`, method, body);
  const execute = (script, args) => api('/execute/sync', 'POST', { script, args: [args] });
  const elementId = (element) => element['element-6066-11e4-a52e-4f735466cecf'];
  async function findQuery(query) {
    let matches = [];
    await e2e.waitFor(`native element ${query.value}`, async () => {
      matches = await api('/elements', 'POST', query);
      return matches.length > 0;
    }, { timeoutMs: 15000, intervalMs: 250 });
    return elementId(matches[0]);
  }
  const find = (value) => findQuery({ using: '-ios predicate string', value });
  const visibleButton = (label) => `type == "XCUIElementTypeButton" AND label == ${JSON.stringify(label)} AND visible == true`;
  const tap = async (id) => {
    const bounds = await rect(id);
    return execute('mobile: tap', { elementId: id, x: bounds.width / 2, y: bounds.height / 2 });
  };
  const click = async (predicate) => tap(await find(predicate));
  const headerActionQuery = {
    using: '-ios class chain',
    value: '**/XCUIElementTypeOther[`name == "chat-header-row"`]/**/XCUIElementTypeButton[`label == "New chat" AND visible == true`]',
  };
  const headerAction = () => findQuery(headerActionQuery);
  const clickNewChat = async () => tap(await headerAction());
  const input = () => find('type == "XCUIElementTypeTextView" AND label BEGINSWITH "Message" AND visible == true');
  const rect = async (id) => api(`/element/${id}/rect`);
  const readValue = async (id) => api(`/element/${id}/attribute/value`);
  async function waitScreen(label) {
    await e2e.waitFor(`native screen contains ${label}`, async () => {
      source = await api('/source');
      return source.includes(label);
    }, { timeoutMs: 45000, intervalMs: 500 });
    await e2e.check(`${label}: no native render or recovery error`, () => !/RCTRedBox|Render Error|Could not load saved app state/.test(source));
  }
  async function capture(name) {
    const png = Buffer.from(await api('/screenshot'), 'base64');
    e2e.writeFile(`logs/${name}.png`, png);
    fs.writeFileSync(path.join(output, `${name}.png`), png);
  }
  async function openDrawer() {
    const rows = await api('/elements', 'POST', {
      using: '-ios predicate string',
      value: `name == ${JSON.stringify(`drawer-chat-row-${threadId}`)} AND visible == true`,
    });
    if (rows.length === 0) {
      await click('type == "XCUIElementTypeButton" AND (label == "Open navigation drawer" OR label == "Show sidebar") AND visible == true');
    }
  }
  async function cleanupDevice() {
    if (sessionId) {
      await request(`/session/${sessionId}`, 'DELETE');
      sessionId = null;
    }
    if (simulator) {
      try {
        await e2e.run('xcrun', ['simctl', 'shutdown', simulator], { timeoutMs: 45000 });
      } finally {
        await e2e.run('xcrun', ['simctl', 'delete', simulator], { timeoutMs: 45000 });
        simulator = null;
      }
    }
  }
  async function nativeFlow(deviceType, label) {
    const runtime = label === 'duo' ? 'com.apple.CoreSimulator.SimRuntime.iOS-27-1' : 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
    simulator = (await e2e.run('xcrun', ['simctl', 'create', e2e.namespace(label), deviceType, runtime])).stdout.trim();
    await e2e.expectMatch(`${label}: unique simulator`, simulator, /^[A-F0-9-]{36}$/i);
    await e2e.run('xcrun', ['simctl', 'boot', simulator]);
    await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 180000 });
    await e2e.run('xcrun', ['simctl', 'install', simulator, builtApp], { timeoutMs: 120000 });
    const session = await request('/session', 'POST', { capabilities: { alwaysMatch: {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': simulator,
      'appium:bundleId': bundleId,
      'appium:noReset': true,
      'appium:isHeadless': true,
      'appium:autoLaunch': false,
      'appium:autoAcceptAlerts': true,
      'appium:derivedDataPath': path.join(e2e.runtimeDir, 'wda'),
      'appium:wdaLocalPort': 8100,
      'appium:mjpegServerPort': 9100,
      'appium:wdaLaunchTimeout': 180000,
      'appium:newCommandTimeout': 600,
      'appium:maxTypingFrequency': 10,
      'appium:waitForIdleTimeout': 0,
      'appium:settings[snapshotMaxDepth]': 80,
    } } });
    sessionId = session.sessionId;
    await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId]);
    await waitScreen('onboarding-choice-bridge');
    await click('name == "onboarding-choice-bridge" AND visible == true');
    await waitScreen('Bridge URL');
    const urlInput = await find('label == "Bridge URL" AND visible == true');
    await tap(urlInput);
    await api(`/element/${urlInput}/value`, 'POST', { text: bridgeUrl });
    await e2e.expectEqual(`${label}: pairing URL is entered exactly`, await readValue(urlInput), bridgeUrl);
    const tokenInput = await find('label == "Bridge token"');
    await execute('mobile: swipe', {
      elementId: await find('type == "XCUIElementTypeScrollView" AND visible == true'),
      direction: 'up',
    });
    await tap(tokenInput);
    await api(`/element/${tokenInput}/value`, 'POST', { text: token });
    await click(visibleButton('Continue'));
    await waitScreen('chat-header-row');
    await e2e.waitFor(`${label}: native bridge connected`, async () => {
      const response = await e2e.requestHttp({ url: `${bridgeUrl}/status`, headers: { Authorization: `Bearer ${token}` } });
      return JSON.parse(response.text).connectedClients > 0;
    }, { timeoutMs: 30000, intervalMs: 500 });
    await openDrawer();
    await waitScreen(`drawer-chat-row-${threadId}`);
    await click(`name == ${JSON.stringify(`drawer-chat-row-${threadId}`)} AND visible == true`);
    await waitScreen('Layout regressions');
    const newChat = await headerAction();
    const newRect = await rect(newChat);
    const titleRect = await rect(await find('name == "chat-header-title-row"'));
    const viewport = await api('/window/rect');
    await e2e.check(`${label}: new chat is at least 48pt square`, () => newRect.width >= 48 && newRect.height >= 48);
    await e2e.check(`${label}: new chat stays inside viewport`, () => newRect.x >= 0 && newRect.y >= 0 && newRect.x + newRect.width <= viewport.width && newRect.y + newRect.height <= viewport.height);
    await e2e.check(`${label}: title stays clear of new chat`, () => titleRect.x + titleRect.width <= newRect.x);
    e2e.writeFile(`logs/${label}-geometry.json`, JSON.stringify({ newRect, titleRect, viewport }));
    fs.writeFileSync(path.join(output, `${label}-geometry.json`), JSON.stringify({ newRect, titleRect, viewport }));
    await capture(`${label}-existing-chat`);
    const draftInput = await input();
    await tap(draftInput);
    await api(`/element/${draftInput}/value`, 'POST', { text: 'Keep this draft in the existing chat.' });
    await capture(`${label}-keyboard`);
    await clickNewChat();
    await waitScreen("Let's build");
    const newInputValue = await readValue(await input());
    await e2e.check(`${label}: new composer does not inherit the old draft`, () => !String(newInputValue).includes('Keep this draft'));
    await e2e.check(`${label}: old transcript no longer appears`, () => !source.includes('Why does the composer overlap'));
    const newButtons = await api('/elements', 'POST', headerActionQuery);
    await e2e.expectEqual(`${label}: redundant header action disappears on new chat`, newButtons.length, 0);
    await capture(`${label}-new-chat`);
    await openDrawer();
    await waitScreen(`drawer-chat-row-${threadId}`);
    await click(`name == ${JSON.stringify(`drawer-chat-row-${threadId}`)} AND visible == true`);
    await waitScreen('Layout regressions');
    await e2e.expectEqual(`${label}: original draft preserved when returning`, await readValue(await input()), 'Keep this draft in the existing chat.');
    await e2e.expectEqual(`${label}: app remains foreground`, await execute('mobile: queryAppState', { bundleId }), 4);
    await cleanupDevice();
  }

  try {
    await e2e.phase('setup', async () => {
      await e2e.run('codesign', ['--verify', '--deep', '--strict', builtApp]);
      await e2e.check('production standalone JavaScript bundle exists', () => fs.statSync(path.join(builtApp, 'main.jsbundle')).size > 0);
      await e2e.run('pnpm', ['run', 'cargo', 'build', '--locked', '--manifest-path', 'services/rust-bridge/Cargo.toml', '--features', 'e2e-agent', '--bin', 'dappercode-bridge', '--bin', 'dappercode-e2e-agent'], { timeoutMs: 180000 });
      const target = (await e2e.run('node', ['scripts/run-cargo.mjs', '--print-target-dir'])).stdout.trim();
      const agentExecutable = e2e.copyIntoRun(path.join(target, 'debug/dappercode-e2e-agent'), 'runtime/dappercode-e2e-agent');
      const bridgeExecutable = e2e.copyIntoRun(path.join(target, 'debug/dappercode-bridge'), 'runtime/dappercode-bridge');
      const scenario = createDefaultScenario();
      const scenarioPath = e2e.writeFile('data/scenario.json', JSON.stringify({ ...scenario, chats: scenario.chats.map(chat => ({ ...chat, cwd: e2e.workspaceDir })) }));
      const controlPath = path.join(e2e.dataDir, 'prompt-control.json');
      const manifestPath = e2e.writeFile('data/agents.json', JSON.stringify({ preferredAgentId: agentId, agents: [{
        enabled: true, displayName: scenario.agentDisplayName, icon: null, agentId,
        executable: agentExecutable, argv: [],
        environment: {
          DAPPERCODE_E2E_SCENARIO_PATH: { kind: 'literal', value: scenarioPath },
          DAPPERCODE_E2E_CONTROL_PATH: { kind: 'literal', value: controlPath },
        },
        resolvedVersion: 'e2e', provenance: 'typed deterministic ACP fixture',
        verifiedDigest: `sha256:${createHash('sha256').update(fs.readFileSync(agentExecutable)).digest('hex')}`,
        integrity: { kind: 'executable' },
      }] }));
      bridge = await e2e.start(bridgeExecutable, [], { label: 'native-bridge', cwd: e2e.workspaceDir, env: {
        BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: '0', BRIDGE_PREVIEW_HOST: '127.0.0.1', BRIDGE_PREVIEW_PORT: '0',
        BRIDGE_DISABLE_BROWSER_PREVIEW: 'true', BRIDGE_WORKDIR: e2e.workspaceDir,
        BRIDGE_STATE_DIR: path.join(e2e.dataDir, 'state'), BRIDGE_ATTACHMENTS_DIR: path.join(e2e.dataDir, 'attachments'),
        ACP_AGENT_MANIFEST: manifestPath, ACP_AGENT_ROOTS: e2e.runtimeDir, ACP_INITIALIZE_TIMEOUT_MS: '15000',
        BRIDGE_AUTH_TOKEN: token, BRIDGE_ALLOW_QUERY_TOKEN_AUTH: 'true', BRIDGE_ALLOW_OUTSIDE_ROOT_CWD: 'false',
        BRIDGE_SHOW_PAIRING_QR: 'false', BRIDGE_OWNER_PID: String(process.pid),
      } });
      const bridgeAddress = await e2e.waitForLog(bridge.label, /rust-bridge listening on (127\.0\.0\.1:\d+)/, { timeoutMs: 30000 });
      bridgeUrl = `http://${bridgeAddress[1]}`;
      const socket = await e2e.openWebSocket('native-bootstrap', `${bridgeUrl.replace('http:', 'ws:')}/rpc`, { headers: { Authorization: `Bearer ${token}` } });
      socket.sendJson({ jsonrpc: '2.0', id: 'bootstrap', method: 'thread/list', params: { limit: 20 } });
      const response = JSON.parse(await socket.nextMessage({ predicate: raw => JSON.parse(raw).id === 'bootstrap' }));
      await e2e.check('authenticated production bridge lists fixture chats', () => !response.error && JSON.stringify(response.result).includes(threadId));
      await socket.close();
      leases.push(await e2e.acquireLease('tcp:127.0.0.1:8100'));
      leases.push(await e2e.acquireLease('tcp:127.0.0.1:9100'));
      const executable = (await e2e.run('which', ['appium'])).stdout.trim();
      appium = await e2e.start('node', [appiumSource, executable], { label: 'native-appium' });
      const address = await e2e.waitForLog(appium.label, /NATIVE_APPIUM_PORT=(\d+)/, { timeoutMs: 30000 });
      appiumUrl = `http://127.0.0.1:${address[1]}`;
      await e2e.expectEqual('owned Appium responds on allocated loopback port', (await request('/status')).ready, true);
    });
    await e2e.phase('iphone', () => nativeFlow('com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro', 'iphone'));
    await e2e.phase('duo', () => nativeFlow('com.apple.CoreSimulator.SimDeviceType.iPhone-Duo', 'duo'));
  } catch (error) {
    if (sessionId) source = await api('/source');
    if (source) fs.writeFileSync(path.join(output, 'native-failure-source.xml'), e2e.redact(source));
    for (const process of [bridge, appium].filter(Boolean)) {
      for (const stream of ['stdout', 'stderr']) {
        console.error(e2e.redact(e2e.readFile(`logs/${process.label}.${stream}.log`).slice(-8000)));
      }
    }
    throw error;
  } finally {
    try {
      await cleanupDevice();
    } finally {
      if (appium) await appium.stop();
      if (bridge) await bridge.stop();
      for (const release of leases.reverse()) await release();
    }
  }
}
