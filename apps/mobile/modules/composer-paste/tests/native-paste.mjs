import path from 'node:path';

export const name = 'native-composer-paste';
export const contract = { requiredPhases: ['build', 'native-paste'] };

export default async function scenario(e2e) {
  const sources = path.join(e2e.worktree, 'apps/mobile/modules/composer-paste');
  const app = path.join(e2e.runtimeDir, 'PasteTest.app');
  let simulator;
  try {
    await e2e.phase('build', async () => {
      e2e.writeFile(
        'runtime/PasteTest.app/Info.plist',
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.dappercode.paste-test</string>
<key>CFBundleExecutable</key><string>PasteTest</string><key>CFBundleName</key><string>PasteTest</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string><key>UILaunchScreen</key><dict/></dict></plist>`,
      );
      const sdk = await e2e.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
      await e2e.run('xcrun', [
        'swiftc',
        '-sdk',
        sdk.stdout.trim(),
        '-target',
        'arm64-apple-ios16.4-simulator',
        path.join(sources, 'ios/ComposerImagePasteHandler.swift'),
        path.join(sources, 'tests/PasteTestApp.swift'),
        '-o',
        path.join(app, 'PasteTest'),
      ]);
      await e2e.run('codesign', ['--force', '--sign', '-', app]);
      await e2e.check('native paste test app compiled', () => true);
    });
    await e2e.phase('native-paste', async () => {
      const created = await e2e.run('xcrun', [
        'simctl',
        'create',
        e2e.runId,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      ]);
      simulator = created.stdout.trim();
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 120000 });
      await e2e.run('xcrun', ['simctl', 'install', simulator, app]);
      const result = await e2e.run(
        'xcrun',
        ['simctl', 'launch', '--console', simulator, 'dev.dappercode.paste-test'],
        { timeoutMs: 30000 },
      );
      await e2e.expectMatch(
        'real UIKit paste sequence',
        result.stdout,
        /COMPOSER_PASTE_NATIVE_PASS/,
      );
    });
  } finally {
    if (simulator) {
      await e2e.run('xcrun', ['simctl', 'shutdown', simulator]);
      await e2e.run('xcrun', ['simctl', 'delete', simulator]);
    }
  }
}
