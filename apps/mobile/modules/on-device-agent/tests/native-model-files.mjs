import path from 'node:path';
import { nativeTestPlist } from './nativeTestPlist.mjs';

export const name = 'on-device-native-model-files';
export const contract = { requiredPhases: ['build', 'native-model-files'] };

export default async function scenario(e2e) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const app = path.join(e2e.runtimeDir, 'NativeModelFiles.app');
  const bundleId = 'dev.dappercode.native-model-files';
  let simulator;
  let booted = false;
  try {
    await e2e.phase('build', async () => {
      e2e.writeFile(
        'runtime/NativeModelFiles.app/Info.plist',
        nativeTestPlist(bundleId, 'NativeModelFiles'),
      );
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
          'arm64-apple-ios16.4-simulator',
          path.join(module, 'ios/ModelFileStore.swift'),
          path.join(module, 'ios/NativeMemory.swift'),
          path.join(module, 'ios/RuntimeDocumentStore.swift'),
          path.join(module, 'tests/NativeModelFileTests.swift'),
          path.join(module, 'tests/NativeTestHost.swift'),
          '-o',
          path.join(app, 'NativeModelFiles'),
        ],
        { timeoutMs: 60_000, env: { SDKROOT: sdk.stdout.trim() } },
      );
      await e2e.run('codesign', ['--force', '--sign', '-', app]);
      await e2e.check('test app compiles production model-file storage', () => true);
    });
    await e2e.phase('native-model-files', async () => {
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
        ['simctl', 'launch', '--console', simulator, bundleId],
        { timeoutMs: 120_000 },
      );
      await e2e.expectMatch(
        'native model-file integrity sequence',
        result.stdout,
        /NATIVE_MODEL_FILES_PASS/,
      );
      for (const line of result.stdout.split('\n').filter((line) => line.startsWith('PASS: '))) {
        await e2e.expectMatch(line.slice(6), line, /^PASS: /);
      }
    });
  } finally {
    if (booted) {
      await e2e.run('xcrun', ['simctl', 'shutdown', simulator]);
    }
    if (simulator) {
      await e2e.run('xcrun', ['simctl', 'delete', simulator]);
    }
  }
}
