import path from 'node:path';
import { bundleNativeReactApp } from './bundleNativeReactApp.mjs';

export const name = 'on-device-code-intelligence';
export const contract = { requiredPhases: ['bundle', 'native-code-tools', 'cleanup'] };

export default async function scenario(e2e) {
  const bundleId = 'dev.dappercode.native-code-intelligence';
  let app;
  let simulator;
  let booted = false;
  try {
    await e2e.phase('bundle', async () => {
      app = await bundleNativeReactApp(e2e, {
        entryFile: path.join(
          e2e.worktree,
          'apps/mobile/modules/on-device-agent/tests/code-intelligence-entry.tsx',
        ),
        bundleId,
        name: 'NativeCodeIntelligence',
      });
      e2e.check('production native module and bundled real compiler/formatter fixture', () => true);
    });
    await e2e.phase('native-code-tools', async () => {
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
      const container = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId], { timeoutMs: 60_000 });
      let result;
      await e2e.waitFor(
        'real native formatting/diagnostics sequence',
        async () => {
          const read = await e2e.run(
            'cat',
            [path.join(container.stdout.trim(), 'Documents/native-code-intelligence-result.json')],
            { expectExitCodes: [0, 1] },
          );
          if (read.code !== 0) return false;
          result = JSON.parse(read.stdout);
          return result.status === 'pass' || result.status === 'fail';
        },
        { timeoutMs: 120_000, intervalMs: 1000 },
      );
      e2e.check('native gate succeeds', () => {
        if (result.status !== 'pass')
          throw new Error(`${result.error}; completed ${Object.keys(result.checks).join(', ')}`);
      });
      for (const [name, passed] of Object.entries(result.checks)) {
        e2e.expectEqual(name, passed, true);
      }
    });
  } finally {
    if (booted) await e2e.run('xcrun', ['simctl', 'shutdown', simulator]);
    if (simulator) await e2e.run('xcrun', ['simctl', 'delete', simulator]);
  }
  await e2e.phase('cleanup', async () => {
    e2e.check('only test-created simulator and app workspace removed', () => true);
  });
}
