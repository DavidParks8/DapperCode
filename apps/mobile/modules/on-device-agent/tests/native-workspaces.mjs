import path from 'node:path';
import { nativeTestPlist } from './nativeTestPlist.mjs';

export const name = 'on-device-native-workspaces';
export const contract = { requiredPhases: ['build', 'native-workspaces'] };

export async function buildNativeWorkspaceApp(
  e2e,
  {
    appName = 'NativeWorkspaces',
    bundleId = 'dev.dappercode.native-workspaces',
    fixture = 'NativeWorkspaceTests.swift',
    sourceRevision = '',
    buildTimeoutMs = 60_000,
  } = {},
) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const library = path.join(module, 'ios/build/git/libgit2.xcframework/ios-arm64_x86_64-simulator');
  const app = path.join(e2e.runtimeDir, `${appName}.app`);
  const sourceNames = [
    'NativeServiceError.swift',
    'GitCredentialStore.swift',
    'NativeGit.swift',
    'GitNetworkOperation.swift',
    'NativeGitRead.swift',
    'NativeGitMutations.swift',
    'NativeGitRemote.swift',
    'WorkspaceStore.swift',
    'WorkspaceFileTools.swift',
    ...(!sourceRevision
      ? [
          'WorkspaceOperation.swift',
          'WorkspaceSecureFiles.swift',
          'WorkspaceSearch.swift',
          'WorkspacePatch.swift',
        ]
      : []),
    'WorkspaceSize.swift',
    'WorkspaceGitTools.swift',
  ];
  const sources = [];
  for (const file of sourceNames) {
    if (sourceRevision) {
      const previous = await e2e.run('git', [
        'show',
        `${sourceRevision}:apps/mobile/modules/on-device-agent/ios/${file}`,
      ]);
      sources.push(e2e.writeFile(`runtime/${appName}-sources/${file}`, previous.stdout));
    } else {
      sources.push(path.join(module, 'ios', file));
    }
  }
  e2e.writeFile(`runtime/${appName}.app/Info.plist`, nativeTestPlist(bundleId, appName));
  const sdk = await e2e.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  const configuration = path.join(e2e.runtimeDir, `${appName}-GitNetworkConfiguration.o`);
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
      '-warnings-as-errors',
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
      ...sources,
      path.join(module, 'tests', fixture),
      path.join(module, 'tests/NativeTestHost.swift'),
      '-o',
      path.join(app, appName),
    ],
    { timeoutMs: buildTimeoutMs, env: { SDKROOT: sdk.stdout.trim() } },
  );
  await e2e.run('codesign', ['--force', '--sign', '-', app]);
  return app;
}

export default async function scenario(e2e) {
  const app = path.join(e2e.runtimeDir, 'NativeWorkspaces.app');
  const bundleId = 'dev.dappercode.native-workspaces';
  let simulator;
  let booted = false;
  try {
    await e2e.phase('build', async () => {
      await buildNativeWorkspaceApp(e2e);
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
