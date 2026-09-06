import { createRequire } from 'node:module';
import path from 'node:path';

export const name = 'native-websocket-background';
export const contract = {
  requiredPhases: ['build', 'baseline', 'rapid-return', 'deadline', 'confirmation'],
};

export default async function scenario(e2e) {
  const mobile = path.join(e2e.worktree, 'apps/mobile');
  const sources = path.join(mobile, 'modules/websocket-background');
  const require = createRequire(path.join(mobile, 'package.json'));
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const expoCore = path.dirname(expoRequire.resolve('expo-modules-core/package.json'));
  const autolinking = expoRequire.resolve('expo-modules-autolinking/bin/expo-modules-autolinking');
  const app = path.join(e2e.runtimeDir, 'BackgroundTest.app');
  const bundle = 'dev.dappercode.background-test';
  const hostBundle = 'dev.dappercode.background-host';
  let simulator;
  let nativeApp;
  try {
    await e2e.phase('build', async () => {
      const resolved = await e2e.run('node', [
        autolinking,
        'resolve',
        '--platform',
        'apple',
        '--project-root',
        mobile,
        '--json',
      ]);
      const module = JSON.parse(resolved.stdout).modules.find(
        (entry) => entry.packageName === 'websocket-background',
      );
      await e2e.expectEqual(
        'Expo autolinking registers the subscriber without JS imports',
        module?.appDelegateSubscribers,
        ['WebSocketBackgroundAppDelegateSubscriber'],
      );
      await e2e.run('node', [
        autolinking,
        'generate-modules-provider',
        '--platform',
        'apple',
        '--project-root',
        mobile,
        '--packages',
        'websocket-background',
        '--target',
        path.join(e2e.runtimeDir, 'ExpoModulesProvider.swift'),
      ]);
      await e2e.expectMatch(
        'generated Expo provider instantiates the production subscriber',
        e2e.readFile('runtime/ExpoModulesProvider.swift'),
        /WebSocketBackgroundAppDelegateSubscriber\.self/,
      );

      e2e.writeFile(
        'runtime/BackgroundTest.app/Info.plist',
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleExecutable</key><string>BackgroundTest</string>
<key>CFBundleName</key><string>BackgroundTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>UILaunchScreen</key><dict/>
</dict></plist>`,
      );
      const sdk = await e2e.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
      const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios16.4-simulator`;
      const common = [
        '-sdk',
        sdk.stdout.trim(),
        '-target',
        target,
        '-swift-version',
        '5',
        '-warnings-as-errors',
      ];
      // Compile against Expo's actual standalone subscriber ABI, not a test replacement.
      const subscriberBase = e2e.copyIntoRun(
        path.join(expoCore, 'ios/AppDelegates/ExpoAppDelegateSubscriber.swift'),
        'runtime/ExpoAppDelegateSubscriber.swift',
      );
      const header = e2e.writeFile('runtime/UIKit.h', '#import <UIKit/UIKit.h>\n');
      await e2e.run(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'swiftc',
          ...common,
          '-import-objc-header',
          header,
          subscriberBase,
          '-emit-library',
          '-static',
          '-emit-module',
          '-module-name',
          'ExpoModulesCore',
          '-emit-module-path',
          path.join(e2e.runtimeDir, 'ExpoModulesCore.swiftmodule'),
          '-o',
          path.join(e2e.runtimeDir, 'libExpoModulesCore.a'),
        ],
        { timeoutMs: 120_000 },
      );
      await e2e.run(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'swiftc',
          ...common,
          '-I',
          e2e.runtimeDir,
          '-L',
          e2e.runtimeDir,
          '-lExpoModulesCore',
          e2e.copyIntoRun(
            path.join(sources, 'ios/WebSocketBackgroundAppDelegateSubscriber.swift'),
            'runtime/WebSocketBackgroundAppDelegateSubscriber.swift',
          ),
          path.join(sources, 'tests/BackgroundTestApp.swift'),
          '-o',
          path.join(app, 'BackgroundTest'),
        ],
        { timeoutMs: 120_000 },
      );
      await e2e.run('codesign', ['--force', '--sign', '-', app]);
      const host = e2e.copyIntoRun(app, 'runtime/BackgroundHost.app');
      e2e.writeFile(
        'runtime/BackgroundHost.app/Info.plist',
        e2e.readFile('runtime/BackgroundTest.app/Info.plist').replace(bundle, hostBundle),
      );
      await e2e.run('codesign', ['--force', '--sign', '-', host]);
      await e2e.check(
        'production Swift compiles with UIKit and the installed Expo subscriber',
        () => true,
      );
    });

    await e2e.phase('baseline', async () => {
      const created = await e2e.run('xcrun', [
        'simctl',
        'create',
        e2e.runId,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      ]);
      simulator = created.stdout.trim();
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 300_000 });
      await e2e.run('xcrun', ['simctl', 'install', simulator, app]);
      await e2e.run('xcrun', [
        'simctl',
        'install',
        simulator,
        path.join(e2e.runtimeDir, 'BackgroundHost.app'),
      ]);
      nativeApp = await e2e.start(
        'xcrun',
        ['simctl', 'launch', '--console-pty', simulator, bundle],
        { label: 'native-app' },
      );
      await e2e.waitForLog(nativeApp.label, /NATIVE_READY/, { timeoutMs: 30_000 });
      await e2e.check(
        'isolated app is alive after denial, stale expiration, and cleanup checks',
        () => nativeApp.isRunning(),
      );
    });

    await e2e.phase('rapid-return', async () => {
      await e2e.run('xcrun', ['simctl', 'launch', simulator, hostBundle, '--background-host']);
      await e2e.waitForLog(nativeApp.label, /NATIVE_BACKGROUND_1/);
      // Drive the return without waiting for a background timer. Deliberately observe it late;
      // the native fixture, not host log delivery, measures the actual six-to-ten-second window.
      await Promise.all([
        new Promise((resolve) => setTimeout(resolve, 6_000)).then(() =>
          e2e.run('xcrun', ['simctl', 'launch', simulator, bundle]),
        ),
        new Promise((resolve) => setTimeout(resolve, 11_000)),
      ]);
      await e2e.waitForLog(nativeApp.label, /NATIVE_FOREGROUND_1/);
      await e2e.check('return before ten seconds releases the budget', () => nativeApp.isRunning());
    });

    await e2e.phase('deadline', async () => {
      await e2e.run('xcrun', ['simctl', 'launch', simulator, hostBundle, '--background-host']);
      await e2e.waitForLog(nativeApp.label, /NATIVE_BACKGROUND_2/);
      await e2e.waitForLog(nativeApp.label, /NATIVE_SIX_SECONDS_2/);
      await e2e.check('main queue still runs beyond the ordinary short suspension window', () =>
        nativeApp.isRunning(),
      );
      await e2e.waitForLog(nativeApp.label, /NATIVE_TEN_SECONDS/, { timeoutMs: 12_000 });
      const deadline = await e2e.waitForLog(nativeApp.label, /NATIVE_DEADLINE elapsed=([\d.]+)/, {
        timeoutMs: 5_000,
      });
      await e2e.check(
        'background callback runs before the bounded native release',
        () => Number(deadline[1]) >= 12 && Number(deadline[1]) < 13.5,
      );
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundle]);
      await e2e.waitForLog(nativeApp.label, /NATIVE_FOREGROUND_2/);
      await e2e.check('return after expiration completes both native lifecycle cycles', () => true);
    });

    await e2e.phase('confirmation', async () => {
      const result = await nativeApp.wait(10_000);
      await e2e.expectEqual('native test app exits successfully', result.code, 0);
      const output = e2e.readFile(path.relative(e2e.root, nativeApp.stdoutPath));
      await e2e.expectMatch(
        'all production lifecycle checks pass',
        output,
        /WEBSOCKET_BACKGROUND_NATIVE_PASS/,
      );
      for (const line of output.split('\n').filter((line) => line.startsWith('PASS: '))) {
        await e2e.expectMatch(line.slice(6), line, /^PASS: /);
      }
    });
  } catch (error) {
    if (simulator) {
      await e2e.run(
        'xcrun',
        [
          'simctl',
          'spawn',
          simulator,
          'log',
          'show',
          '--last',
          '1m',
          '--style',
          'compact',
          '--predicate',
          `eventMessage CONTAINS "${bundle}"`,
        ],
        { label: 'failure-system-log' },
      );
    }
    const output = nativeApp ? e2e.readFile(path.relative(e2e.root, nativeApp.stdoutPath)) : '';
    throw new Error(`${error.message}\n${output}`);
  } finally {
    if (nativeApp) await nativeApp.stop();
    if (simulator) {
      try {
        await e2e.run('xcrun', ['simctl', 'shutdown', simulator]);
      } finally {
        await e2e.run('xcrun', ['simctl', 'delete', simulator]);
      }
    }
  }
}
