import path from 'node:path';

export const name = 'native-ios-launch';
export const contract = {
  requiredPhases: ['setup', 'cold-launch', 'interaction', 'relaunch', 'resume', 'deep-links'],
};

export default async function scenario(e2e) {
  const bundleId = 'com.dappermagna.tethercode';
  const runtime = process.env.IOS_RUNTIME ?? 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
  const builtApp =
    process.env.IOS_LAUNCH_APP ??
    path.join(
      e2e.worktree,
      'apps/mobile/ios/build/Build/Products/Release-iphonesimulator/DapperCode.app',
    );
  let simulator;
  let booted = false;
  let appium;
  let sessionId;
  let lastSource;
  const baseUrl = 'http://127.0.0.1:4727';
  // Appium rejects port 0; serialize its listener and the driver's fixed native ports.
  const releaseAppium = await e2e.acquireLease('tcp:127.0.0.1:4727');
  const releaseWda = await e2e.acquireLease('tcp:127.0.0.1:8100');
  const releaseMjpeg = await e2e.acquireLease('tcp:127.0.0.1:9100');

  async function request(endpoint, method = 'GET', body) {
    const response = await e2e.requestHttp({
      url: `${baseUrl}${endpoint}`,
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 300000,
      maxBodyBytes: 8 * 1024 * 1024,
      expectStatus: [200, 500],
    });
    const result = JSON.parse(response.text);
    if (response.status !== 200 || result.value?.error) {
      throw new Error(JSON.stringify(result.value));
    }
    return result.value;
  }

  function execute(script, args) {
    return request(`/session/${sessionId}/execute/sync`, 'POST', { script, args: [args] });
  }

  async function assertScreen(label) {
    const visibleLabel = new RegExp(`label="[^"]*${label}[^"]*"[^>]*visible="true"`);
    await e2e.waitFor(
      `native screen contains ${label}`,
      async () => {
        const state = await execute('mobile: queryAppState', { bundleId });
        if (state !== 4) throw new Error(`DapperCode is not foreground: state ${state}`);
        lastSource = await request(`/session/${sessionId}/source`);
        return visibleLabel.test(lastSource);
      },
      { timeoutMs: 45000, intervalMs: 1000 },
    );
    await e2e.expectMatch(`visible ${label}`, lastSource, visibleLabel);
    await e2e.check(
      'no loading, recovery, or render-error screen',
      () =>
        !/RCTRedBox|Render Error|Could not load saved app state|Loading DapperCode/.test(
          lastSource,
        ),
    );
    await e2e.expectEqual(
      'app remains foreground',
      await execute('mobile: queryAppState', { bundleId }),
      4,
    );
  }

  try {
    await e2e.phase('setup', async () => {
      const runtimes = JSON.parse(
        (await e2e.run('xcrun', ['simctl', 'list', 'runtimes', '--json'])).stdout,
      );
      await e2e.check('requested iOS runtime is available', () =>
        runtimes.runtimes.some((entry) => entry.identifier === runtime && entry.isAvailable),
      );
      const app = e2e.copyIntoRun(builtApp, 'runtime/DapperCode.app');
      const bundle = await e2e.run('test', ['-s', path.join(app, 'main.jsbundle')]);
      await e2e.expectEqual('standalone release JavaScript is embedded', bundle.code, 0);
      await e2e.run('codesign', ['--verify', '--deep', '--strict', app]);
      simulator = (
        await e2e.run('xcrun', [
          'simctl',
          'create',
          e2e.runId,
          'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          runtime,
        ])
      ).stdout.trim();
      await e2e.expectMatch('run owns a fresh simulator', simulator, /^[A-F0-9-]{36}$/i);
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      booted = true;
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 300000 });
      await e2e.run('xcrun', ['simctl', 'install', simulator, app], { timeoutMs: 120000 });
      appium = await e2e.start(
        'appium',
        ['--address', '127.0.0.1', '--port', '4727', '--log-no-colors'],
        { label: 'appium' },
      );
      await e2e.waitForLog(
        appium.label,
        /Appium REST http interface listener started on http:\/\/127\.0\.0\.1:4727/,
        { timeoutMs: 30000 },
      );
      await e2e.expectEqual(
        'owned UI server is responsive',
        (await request('/status')).ready,
        true,
      );
      const session = await request('/session', 'POST', {
        capabilities: {
          alwaysMatch: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:udid': simulator,
            'appium:bundleId': bundleId,
            'appium:noReset': true,
            'appium:isHeadless': true,
            'appium:autoLaunch': false,
            'appium:shouldTerminateApp': false,
            'appium:derivedDataPath': path.join(e2e.runtimeDir, 'wda'),
            'appium:wdaLocalPort': 8100,
            'appium:wdaLaunchTimeout': 180000,
            'appium:wdaStartupRetries': 1,
            'appium:mjpegServerPort': 9100,
            'appium:newCommandTimeout': 180,
          },
        },
      });
      sessionId = session.sessionId;
      await e2e.check('native UI automation is responsive', () => Boolean(sessionId));
    });
    await e2e.phase('cold-launch', async () => {
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId]);
      await assertScreen('Private connection');
    });
    await e2e.phase('interaction', async () => {
      const element = await request(`/session/${sessionId}/element`, 'POST', {
        using: '-ios predicate string',
        value: 'label CONTAINS "Private connection" AND visible == true',
      });
      const elementId = element['element-6066-11e4-a52e-4f735466cecf'];
      await request(`/session/${sessionId}/element/${elementId}/click`, 'POST', {});
      await assertScreen('Bridge URL');
    });
    await e2e.phase('relaunch', async () => {
      await execute('mobile: terminateApp', { bundleId });
      await e2e.expectEqual(
        'process is terminated before cold restart',
        await execute('mobile: queryAppState', { bundleId }),
        1,
      );
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId]);
      await assertScreen('Private connection');
    });
    await e2e.phase('resume', async () => {
      const processId = lastSource.match(/processId="(\d+)"/)?.[1];
      await e2e.check('foreground process is identified', () => Boolean(processId));
      await execute('mobile: pressButton', { name: 'home' });
      await e2e.waitFor(
        'home moves the live app into background',
        async () => [2, 3].includes(await execute('mobile: queryAppState', { bundleId })),
        { timeoutMs: 15000, intervalMs: 250 },
      );
      await e2e.check('app remains alive in background', async () =>
        [2, 3].includes(await execute('mobile: queryAppState', { bundleId })),
      );
      await execute('mobile: activateApp', { bundleId });
      await assertScreen('Private connection');
      await e2e.expectEqual(
        'foreground resumes the same process rather than relaunching a crashed app',
        lastSource.match(/processId="(\d+)"/)?.[1],
        processId,
      );
      await e2e.run('xcrun', [
        'simctl',
        'io',
        simulator,
        'screenshot',
        path.join(e2e.logDir, 'onboarding.png'),
      ]);
    });
    await e2e.phase('deep-links', async () => {
      await execute('mobile: deepLink', { url: 'dappercode://launch-test-missing', bundleId });
      await assertScreen('Page not found');
      await execute('mobile: deepLink', { url: 'dappercode://onboarding', bundleId });
      await assertScreen('Private connection');
      await execute('mobile: terminateApp', { bundleId });
      await execute('mobile: deepLink', { url: 'dappercode://launch-test-missing', bundleId });
      await assertScreen('Page not found');
      await execute('mobile: deepLink', { url: 'dappercode://onboarding', bundleId });
      await assertScreen('Private connection');
    });
  } catch (error) {
    if (lastSource) process.stderr.write(`\nLAST_NATIVE_UI\n${lastSource}\n`);
    if (appium) {
      process.stderr.write(e2e.readFile('logs/appium.stdout.log').slice(-8000));
      process.stderr.write(e2e.readFile('logs/appium.stderr.log').slice(-8000));
    }
    if (simulator) {
      const devices = JSON.parse(
        (await e2e.run('xcrun', ['simctl', 'list', 'devices', '--json'])).stdout,
      );
      booted = Object.values(devices.devices)
        .flat()
        .some((entry) => entry.udid === simulator && entry.state === 'Booted');
    }
    if (booted) {
      const diagnostics = await e2e.run(
        'xcrun',
        [
          'simctl',
          'spawn',
          simulator,
          'log',
          'show',
          '--last',
          '4m',
          '--style',
          'compact',
          '--predicate',
          'process == "DapperCode" AND subsystem != "com.apple.dt.xctest"',
        ],
        { timeoutMs: 45000 },
      );
      process.stderr.write(diagnostics.stdout.slice(-22000));
    }
    throw error;
  } finally {
    try {
      if (sessionId) await request(`/session/${sessionId}`, 'DELETE');
    } finally {
      try {
        if (appium) await appium.stop();
      } finally {
        try {
          if (simulator) {
            try {
              if (booted)
                await e2e.run('xcrun', ['simctl', 'shutdown', simulator], { timeoutMs: 45000 });
            } finally {
              await e2e.run('xcrun', ['simctl', 'delete', simulator], { timeoutMs: 45000 });
            }
          }
        } finally {
          await releaseMjpeg();
          await releaseWda();
          await releaseAppium();
        }
      }
    }
  }
}
