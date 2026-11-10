import path from 'node:path';
import { nativeTestPlist } from './nativeTestPlist.mjs';

export const name = 'on-device-native-local-run';
export const contract = {
  requiredPhases: ['build', 'foreground', 'background', 'release', 'confirmation'],
};

// A local agent run must keep the process alive after the app leaves the foreground, and must
// release that budget as soon as the run settles.
export default async function scenario(e2e) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const app = path.join(e2e.runtimeDir, 'LocalRun.app');
  const bundle = 'dev.dappercode.local-run';
  const hostBundle = 'dev.dappercode.local-run-host';
  let simulator;
  let nativeApp;
  let kind;
  const ticks = () =>
    [
      ...e2e
        .readFile(path.relative(e2e.root, nativeApp.stdoutPath))
        .matchAll(/NATIVE_TICK elapsed=(\d+) background=(true|false)/g),
    ].map((match) => ({ elapsed: Number(match[1]), background: match[2] === 'true' }));
  try {
    await e2e.phase('build', async () => {
      const plist = (bundleId) =>
        nativeTestPlist(bundleId, 'LocalRun')
          .replace('NativeTestScene', 'LocalRunTestScene')
          .replace(
            '<key>UILaunchScreen</key>',
            `<key>BGTaskSchedulerPermittedIdentifiers</key><array><string>${bundleId}.localrun.*</string></array>\n<key>UILaunchScreen</key>`,
          );
      e2e.writeFile('runtime/LocalRun.app/Info.plist', plist(bundle));
      const sdk = await e2e.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
      await e2e.run(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'swiftc',
          '-sdk',
          sdk.stdout.trim(),
          '-target',
          `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios16.4-simulator`,
          '-swift-version',
          '5',
          '-warnings-as-errors',
          '-framework',
          'BackgroundTasks',
          '-framework',
          'Security',
          path.join(module, 'ios/LocalRunActivity.swift'),
          path.join(module, 'ios/NativeServiceError.swift'),
          path.join(module, 'ios/GitCredentialStore.swift'),
          path.join(module, 'tests/NativeLocalRunTests.swift'),
          '-o',
          path.join(app, 'LocalRun'),
        ],
        { timeoutMs: 120_000 },
      );
      await e2e.run('codesign', ['--force', '--sign', '-', app]);
      const host = e2e.copyIntoRun(app, 'runtime/LocalRunHost.app');
      e2e.writeFile('runtime/LocalRunHost.app/Info.plist', plist(hostBundle));
      await e2e.run('codesign', ['--force', '--sign', '-', host]);
      await e2e.check('production activity sources compile with UIKit and BackgroundTasks', () =>
        e2e.readFile('runtime/LocalRun.app/Info.plist').includes(`${bundle}.localrun.*`),
      );
    });

    await e2e.phase('foreground', async () => {
      const created = await e2e.run('xcrun', [
        'simctl',
        'create',
        e2e.runId,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      ]);
      simulator = created.stdout.trim();
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 300_000 });
      await e2e.run('xcrun', ['simctl', 'install', simulator, app], { timeoutMs: 120_000 });
      await e2e.run(
        'xcrun',
        ['simctl', 'install', simulator, path.join(e2e.runtimeDir, 'LocalRunHost.app')],
        { timeoutMs: 120_000 },
      );
      nativeApp = await e2e.start(
        'xcrun',
        ['simctl', 'launch', '--console-pty', simulator, bundle],
        { label: 'native-app' },
      );
      const ready = await e2e.waitForLog(
        nativeApp.label,
        /NATIVE_READY kind=(\w+) scheduler=(\w+)|LOCAL_RUN_NATIVE_FAIL: (.*)/,
        { timeoutMs: 60_000 },
      );
      await e2e.expectEqual('foreground native checks pass', ready[3], undefined);
      kind = ready[1];
      // Simulators have no BGTaskScheduler; there the run must hold the short background budget.
      await e2e.expectEqual(
        'the run holds the strongest activity the platform offers',
        kind,
        ready[2] === 'available' ? 'continued' : 'background',
      );
    });

    await e2e.phase('background', async () => {
      await e2e.run('xcrun', ['simctl', 'launch', simulator, hostBundle, '--background-host']);
      await e2e.waitForLog(nativeApp.label, new RegExp(`NATIVE_BACKGROUND kind=${kind}`), {
        timeoutMs: 15_000,
      });
      await e2e.waitForLog(nativeApp.label, /NATIVE_RELEASED elapsed=(\d+)/, { timeoutMs: 70_000 });
      const background = ticks().filter((tick) => tick.background);
      const latest = Math.max(...background.map((tick) => tick.elapsed));
      if (kind === 'continued') {
        await e2e.check(
          'work continued past the 30-second short background budget',
          () => latest >= 45,
        );
      } else {
        // An app without a task is suspended within about five seconds of leaving the foreground.
        await e2e.check('the short background budget kept the run executing', () => latest >= 15);
        const [, , remaining] = await e2e.waitForLog(
          nativeApp.label,
          /NATIVE_DEADLINE elapsed=(\d+) remaining=(\d+)/,
        );
        await e2e.check(
          'the run was warned with time left to stop, unload, and save',
          () => Number(remaining) >= 5,
        );
      }
      await e2e.check('the background run was never suspended for more than a few seconds', () =>
        background.every(
          (tick, index) => index === 0 || tick.elapsed - background[index - 1].elapsed <= 3,
        ),
      );
    });

    await e2e.phase('release', async () => {
      const released = Number(
        (await e2e.waitForLog(nativeApp.label, /NATIVE_RELEASED elapsed=(\d+)/))[1],
      );
      // Elapsed time is the input here: after release the system must suspend the idle app.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const latest = Math.max(...ticks().map((tick) => tick.elapsed));
      await e2e.check(
        'releasing the settled run lets iOS suspend the app',
        () => latest < released + 15,
      );
      await e2e.check('the app process survives suspension', () => nativeApp.isRunning());
    });

    await e2e.phase('confirmation', async () => {
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundle]);
      const result = await nativeApp.wait(30_000);
      await e2e.expectEqual('native test app exits successfully', result.code, 0);
      const output = e2e.readFile(path.relative(e2e.root, nativeApp.stdoutPath));
      await e2e.expectMatch('all native activity checks pass', output, /LOCAL_RUN_NATIVE_PASS/);
      for (const line of output.split('\n').filter((line) => line.startsWith('PASS: '))) {
        await e2e.expectMatch(line.slice(6).trim(), line, /^PASS: /);
      }
    });
  } catch (error) {
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
