import path from 'node:path';
import { nativeTestPlist } from './nativeTestPlist.mjs';

export const name = 'on-device-native-workspaces';
export const contract = { requiredPhases: ['build', 'native-workspaces'] };

export default async function scenario(e2e) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const library = path.join(module, 'ios/build/git/libgit2.xcframework/ios-arm64_x86_64-simulator');
  const app = path.join(e2e.runtimeDir, 'NativeWorkspaces.app');
  const bundleId = 'dev.dappercode.native-workspaces';
  let simulator;
  let booted = false;
  try {
    await e2e.phase('build', async () => {
      e2e.writeFile(
        'runtime/NativeWorkspaces.app/Info.plist',
        nativeTestPlist(bundleId, 'NativeWorkspaces'),
      );
      const sdk = await e2e.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
      const configuration = path.join(e2e.runtimeDir, 'GitNetworkConfiguration.o');
      await e2e.run(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'clang',
          '-target',
          'arm64-apple-ios16.4-simulator',
          '-isysroot',
          sdk.stdout.trim(),
          '-I',
          path.join(library, 'Headers'),
          '-c',
          path.join(module, 'ios/GitNetworkConfiguration.m'),
          '-o',
          configuration,
        ],
        { timeoutMs: 30_000 },
      );
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
          '-I',
          path.join(library, 'Headers'),
          '-L',
          library,
          '-lgit2',
          '-framework',
          'Security',
          '-framework',
          'CoreFoundation',
          '-liconv',
          '-lz',
          '-import-objc-header',
          path.join(module, 'ios/GitNetworkConfiguration.h'),
          configuration,
          path.join(module, 'ios/NativeServiceError.swift'),
          path.join(module, 'ios/GitCredentialStore.swift'),
          path.join(module, 'ios/NativeGit.swift'),
          path.join(module, 'ios/GitNetworkOperation.swift'),
          path.join(module, 'ios/NativeGitRead.swift'),
          path.join(module, 'ios/NativeGitMutations.swift'),
          path.join(module, 'ios/NativeGitRemote.swift'),
          path.join(module, 'ios/WorkspaceStore.swift'),
          path.join(module, 'ios/WorkspaceFileTools.swift'),
          path.join(module, 'ios/WorkspaceSize.swift'),
          path.join(module, 'ios/WorkspaceGitTools.swift'),
          path.join(module, 'tests/NativeWorkspaceTests.swift'),
          path.join(module, 'tests/NativeTestHost.swift'),
          '-o',
          path.join(app, 'NativeWorkspaces'),
        ],
        { timeoutMs: 60_000, env: { SDKROOT: sdk.stdout.trim() } },
      );
      await e2e.run('codesign', ['--force', '--sign', '-', app]);
      await e2e.check(
        'test app compiles the production workspace actor, file tools, and Git tools',
        () => true,
      );
    });
    await e2e.phase('native-workspaces', async () => {
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
      await e2e.expectMatch('native workspace sequence', result.stdout, /NATIVE_WORKSPACE_PASS/);
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
