import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const name = 'native-new-chat';
export const contract = { requiredPhases: process.env.NATIVE_ONLY_DUO === 'true' ? ['setup', 'duo'] : ['setup', 'iphone', 'duo'] };

export default async function scenario(e2e) {
  const bundleId = 'com.dappermagna.tethercode';
  const output = path.dirname(new URL(import.meta.url).pathname);
  const builtApp = path.join(e2e.worktree, 'apps/mobile/ios/build/Build/Products/Release-iphonesimulator/DapperCode.app');
  const token = e2e.createSecret();
  const agentId = 'local-primary';
  const threadId = `v1.${Buffer.from(agentId).toString('base64url')}.${Buffer.from('thread-layout').toString('base64url')}`;
  const appiumSource = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent/tests/appium-server.mjs');
  const { createDefaultScenario } = await import(pathToFileURL(path.join(e2e.worktree, 'e2e/harness/scenario.ts')));
  const { nativeOnDeviceSelectors } = await import(pathToFileURL(path.join(e2e.worktree, 'e2e/fixtures/selectors.ts')));
  let appiumUrl;
  let bridgeUrl;
  let appium;
  let bridge;
  let deviceHub;
  let sessionId;
  let simulator;
  let deviceLabel;
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
  const railActionQuery = {
    using: '-ios class chain',
    value: `**/XCUIElementTypeOther[\`name == "${nativeOnDeviceSelectors.chatNewChatRail}"\`]/**/XCUIElementTypeButton[\`label == "New chat" AND visible == true\`]`,
  };
  const actionQuery = () => deviceLabel === 'duo' ? railActionQuery : headerActionQuery;
  const headerAction = () => findQuery(actionQuery());
  const clickNewChat = async () => {
    const buttons = await api('/elements', 'POST', actionQuery());
    if (deviceLabel === 'duo' && buttons.length === 0) {
      const more = await find(visibleButton('More'));
      const moreBounds = await rect(more);
      fs.writeFileSync(path.join(output, 'system-menu-trigger-geometry.json'), JSON.stringify(moreBounds));
      await click(visibleButton('More'));
      source = await api('/source');
      fs.writeFileSync(path.join(output, 'system-menu-source.xml'), e2e.redact(source));
      await capture('duo-overflow');
      await e2e.check('iOS overflow does not present a custom bottom sheet', () => !source.includes('Bottom Sheet') && !source.includes('selection-sheet-close'));
      await e2e.check('system menu keeps the keyboard visible', () => /XCUIElementTypeKeyboard[^>]*visible="true"/.test(source));
      const option = await findQuery({
        using: '-ios class chain',
        value: nativeOnDeviceSelectors.chatNewChatOverflow.classChain,
      });
      let bounds;
      let previous;
      const viewport = await api('/window/rect');
      await e2e.waitFor('new-chat overflow row finishes animating inside the viewport', async () => {
        bounds = await rect(option);
        const stable = previous && Math.abs(previous.x - bounds.x) < 0.5 && Math.abs(previous.y - bounds.y) < 0.5;
        previous = bounds;
        return stable && bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height;
      }, { timeoutMs: 15000, intervalMs: 500 });
      await e2e.check('new chat is accessible in the system menu', () => bounds.width > 0 && bounds.height > 0);
      await capture('duo-overflow');
      await execute('mobile: tap', { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    } else {
      await tap(await headerAction());
    }
  };
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
    e2e.writeFile(`logs/system-menu-${name}.png`, png);
    fs.writeFileSync(path.join(output, `system-menu-${name}.png`), png);
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
    deviceLabel = label;
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
    if (label === 'duo') {
      const headerButtons = await api('/elements', 'POST', headerActionQuery);
      await e2e.expectEqual('Duo has no duplicate new-chat button in the header', headerButtons.length, 0);
      const railRect = await rect(await find('name == "scene-vertical-toolbar"'));
      await e2e.check('Duo new-chat action is fully contained in the rail', () =>
        newRect.x >= railRect.x && newRect.y >= railRect.y &&
        newRect.x + newRect.width <= railRect.x + railRect.width &&
        newRect.y + newRect.height <= railRect.y + railRect.height);
    }
    e2e.writeFile(`logs/${label}-geometry.json`, JSON.stringify({ newRect, titleRect, viewport }));
    fs.writeFileSync(path.join(output, `rail-${label}-geometry.json`), JSON.stringify({ newRect, titleRect, viewport }));
    await capture(`${label}-existing-chat`);
    await clickNewChat();
    await waitScreen("Let's build");
    await e2e.check(`${label}: direct new-chat action opens a clean composer`, async () => !String(await readValue(await input())).includes('Keep this draft'));
    await openDrawer();
    await click(`name == ${JSON.stringify(`drawer-chat-row-${threadId}`)} AND visible == true`);
    await waitScreen('Layout regressions');
    const draftInput = await input();
    await tap(draftInput);
    await api(`/element/${draftInput}/value`, 'POST', { text: 'Keep this draft in the existing chat.' });
    await capture(`${label}-keyboard`);
    await clickNewChat();
    await waitScreen("Let's build");
    const newInputValue = await readValue(await input());
    await e2e.check(`${label}: new composer does not inherit the old draft`, () => !String(newInputValue).includes('Keep this draft'));
    await e2e.check(`${label}: old transcript no longer appears`, () => !source.includes('Why does the composer overlap'));
    const newButtons = await api('/elements', 'POST', actionQuery());
    await e2e.expectEqual(`${label}: redundant header action disappears on new chat`, newButtons.length, 0);
    await capture(`${label}-new-chat`);
    await openDrawer();
    await waitScreen(`drawer-chat-row-${threadId}`);
    await click(`name == ${JSON.stringify(`drawer-chat-row-${threadId}`)} AND visible == true`);
    await waitScreen('Layout regressions');
    await e2e.expectEqual(`${label}: original draft preserved when returning`, await readValue(await input()), 'Keep this draft in the existing chat.');
    await e2e.expectEqual(`${label}: app remains foreground`, await execute('mobile: queryAppState', { bundleId }), 4);
    if (label === 'duo' && process.env.NATIVE_DUO_POSES === 'true') {
      leases.push(await e2e.acquireLease('macos-device-hub'));
      const existing = await e2e.run('osascript', ['-e', 'tell application "System Events" to get exists process "DeviceHub"']);
      await e2e.expectEqual('no user Device Hub session is repurposed', existing.stdout.trim(), 'false');
      deviceHub = await e2e.start('/Applications/Xcode.app/Contents/Applications/DeviceHub.app/Contents/MacOS/DeviceHub', ['-CurrentDeviceUDID', simulator], { label: 'owned-device-hub' });
      await e2e.waitFor('owned Device Hub opens a window', async () => {
        const windows = await e2e.run('osascript', ['-e', 'tell application "System Events"\nif exists process "DeviceHub" then\nreturn count of windows of process "DeviceHub"\nelse\nreturn 0\nend if\nend tell'], { timeoutMs: 10000 });
        return Number(windows.stdout.trim()) > 0;
      }, { timeoutMs: 20000, intervalMs: 500 });
      const controls = await e2e.run('osascript', ['-e', `
        tell application "System Events"
          tell process "DeviceHub"
            set frontmost to true
            log "WINDOW: " & name of window 1
            set uiItems to entire contents of window 1
            repeat with uiIndex from 1 to count of uiItems
              set uiItem to item uiIndex of uiItems
                set itemRole to get role of uiItem
                if itemRole is "AXButton" or itemRole is "AXRadioButton" or itemRole is "AXPopUpButton" then
                  set itemName to get name of uiItem
                  set itemDescription to get description of uiItem
                  log {"BUTTON:", itemRole, itemName, itemDescription}
                end if
            end repeat
          end tell
        end tell
      `], { timeoutMs: 20000 });
      fs.writeFileSync(path.join(output, 'duo-device-hub-controls.txt'), controls.stderr + controls.stdout);
      await e2e.check('Duo pose controls are inspectable', () => controls.stderr.includes('BUTTON:'));
      async function poseButton(buttonName) {
        const clicked = await e2e.run('osascript', ['-e', `
          tell application "System Events"
            tell process "DeviceHub"
              set frontmost to true
              set uiItems to entire contents of window 1
              repeat with uiIndex from 1 to count of uiItems
                set uiItem to item uiIndex of uiItems
                  set itemRole to get role of uiItem
                  if itemRole is "AXButton" or itemRole is "AXRadioButton" then
                    set itemName to get name of uiItem
                    set itemDescription to get description of uiItem
                    if itemName is ${JSON.stringify(buttonName)} or itemDescription is ${JSON.stringify(buttonName)} then
                      click uiItem
                      return "clicked"
                    end if
                  end if
              end repeat
            end tell
          end tell
          error "Missing pose control"
        `], { timeoutMs: 20000 });
        await e2e.expectEqual(`Device Hub selected ${buttonName}`, clicked.stdout.trim(), 'clicked');
      }
      for (const [pose, button, width, height] of [
        ['open', 'Open', 951, 669],
        ['book', 'Partially Open', 951, 669],
        ['laptop', 'Rotate Right', 669, 951],
      ]) {
        await poseButton(button);
        await e2e.waitFor(`Duo ${pose} viewport settles`, async () => {
          const frame = await api('/window/rect');
          return frame.width === width && frame.height === height;
        }, { timeoutMs: 45000, intervalMs: 500 });
        await waitScreen('Layout regressions');
        const actionRect = await rect(await headerAction());
        const title = await rect(await find('name == "chat-header-title-row"'));
        await e2e.check(`Duo ${pose}: new chat remains a 48pt target inside the viewport`, () =>
          actionRect.width >= 48 && actionRect.height >= 48 &&
          actionRect.x >= 0 && actionRect.y >= 0 &&
          actionRect.x + actionRect.width <= width && actionRect.y + actionRect.height <= height);
        await e2e.check(`Duo ${pose}: title remains clear of new chat`, () => title.x + title.width <= actionRect.x);
        if (pose === 'laptop') {
          await e2e.check('Duo laptop: new chat remains above the hinge', () => actionRect.y + actionRect.height < 455.5);
        }
        const screenshot = path.join(e2e.logDir, `duo-${pose}-native.png`);
        await e2e.run('xcrun', ['simctl', 'io', simulator, 'screenshot', '--display=primary-1', screenshot], { timeoutMs: 30000 });
        fs.copyFileSync(screenshot, path.join(output, `duo-${pose}-native.png`));
        await clickNewChat();
        await waitScreen("Let's build");
        await e2e.check(`Duo ${pose}: one tap opens a clean composer`, async () => !String(await readValue(await input())).includes('Keep this draft'));
        await openDrawer();
        await click(`name == ${JSON.stringify(`drawer-chat-row-${threadId}`)} AND visible == true`);
        await waitScreen('Layout regressions');
        await e2e.expectEqual(`Duo ${pose}: original draft survives`, await readValue(await input()), 'Keep this draft in the existing chat.');
      }
    }
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
    if (process.env.NATIVE_ONLY_DUO !== 'true') {
      await e2e.phase('iphone', () => nativeFlow('com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro', 'iphone'));
    }
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
      if (deviceHub) await deviceHub.stop();
      for (const release of leases.reverse()) await release();
    }
  }
}
