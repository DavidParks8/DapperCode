import { buildNativeWorkspaceApp } from './native-workspaces.mjs';

export const name = 'on-device-retained-workspace-upgrade';
export const contract = { requiredPhases: ['build', 'prior-build', 'upgrade'] };
const priorRevision = '179be2006dc1d352df47a5a6653fbf381fd076e4';

export default async function scenario(e2e) {
  const bundleId = 'dev.dappercode.native-workspace-upgrade';
  let previous;
  let current;
  let simulator;
  let booted = false;
  try {
    await e2e.phase('build', async () => {
      previous = await buildNativeWorkspaceApp(e2e, {
        appName: 'WorkspaceBefore',
        bundleId,
        fixture: 'NativeWorkspaceUpgradeTests.swift',
        sourceRevision: priorRevision,
      });
      current = await buildNativeWorkspaceApp(e2e, {
        appName: 'WorkspaceAfter',
        bundleId,
        fixture: 'NativeWorkspaceUpgradeTests.swift',
      });
      await e2e.run('plutil', [
        '-replace',
        'CFBundleVersion',
        '-string',
        '2',
        `${current}/Info.plist`,
      ]);
      await e2e.run('codesign', ['--force', '--sign', '-', current]);
      await e2e.expectMatch(
        'the old native writer is the released production revision',
        priorRevision,
        /^179be2006dc1d352df47a5a6653fbf381fd076e4$/u,
      );
    });
    await e2e.phase('prior-build', async () => {
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
      await e2e.run('xcrun', ['simctl', 'install', simulator, previous], { timeoutMs: 120_000 });
      const seed = await e2e.run(
        'xcrun',
        ['simctl', 'launch', '--console', simulator, bundleId, '--seed'],
        { timeoutMs: 120_000 },
      );
      await e2e.expectMatch(
        'the prior production writer persists native files, metadata and Git',
        seed.stdout,
        /NATIVE_WORKSPACE_UPGRADE_SEED_PASS/u,
      );
    });
    await e2e.phase('upgrade', async () => {
      await e2e.run('xcrun', ['simctl', 'install', simulator, current], { timeoutMs: 120_000 });
      const probe = await e2e.run('xcrun', ['simctl', 'launch', '--console', simulator, bundleId], {
        timeoutMs: 120_000,
      });
      await e2e.expectMatch(
        'the upgraded app reads the same container without reset',
        probe.stdout,
        /NATIVE_WORKSPACE_UPGRADE_PASS/u,
      );
      for (const line of probe.stdout.split('\n').filter((entry) => entry.startsWith('PASS: '))) {
        await e2e.expectMatch(line.slice(6), line, /^PASS: /u);
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
