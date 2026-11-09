import { buildNativeWorkspaceApp } from './native-workspaces.mjs';

export const name = 'on-device-native-workspace-tools';
export const contract = { requiredPhases: ['build', 'native-tools'] };

export default async function scenario(e2e) {
  const bundleId = 'dev.dappercode.native-workspace-tools';
  let app;
  let simulator;
  let booted = false;
  try {
    await e2e.phase('build', async () => {
      app = await buildNativeWorkspaceApp(e2e, {
        appName: 'NativeWorkspaceTools',
        bundleId,
        fixture: 'NativeWorkspaceToolsTests.swift',
        buildTimeoutMs: 180_000,
      });
      await e2e.check('production workspace search and patch actor compiles', () => true);
    });
    await e2e.phase('native-tools', async () => {
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
      const result = await e2e.run(
        'xcrun',
        [
          'simctl',
          'launch',
          '--console',
          simulator,
          bundleId,
          '--path-alias-root',
          e2e.workspaceDir,
        ],
        { timeoutMs: 120_000 },
      );
      await e2e.expectMatch('native tools sequence', result.stdout, /NATIVE_WORKSPACE_TOOLS_PASS/);
      for (const line of result.stdout.split('\n').filter((line) => line.startsWith('PASS: '))) {
        await e2e.expectMatch(line.slice(6), line, /^PASS: /);
      }
    });
  } finally {
    if (booted) await e2e.run('xcrun', ['simctl', 'shutdown', simulator]);
    if (simulator) await e2e.run('xcrun', ['simctl', 'delete', simulator]);
  }
}
