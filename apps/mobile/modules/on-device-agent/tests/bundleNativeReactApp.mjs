import path from 'node:path';

export async function bundleNativeReactApp(e2e, { entryFile, bundleId, name }) {
  const mobile = path.join(e2e.worktree, 'apps/mobile');
  const app = e2e.copyIntoRun(
    path.join(
      mobile,
      'local-builds/on-device-gate/Build/Products/Release-iphonesimulator/DapperCode.app',
    ),
    `runtime/${name}.app`,
  );
  await e2e.run(
    'pnpm',
    [
      '--filter',
      '@dappercode/mobile',
      'exec',
      'expo',
      'export:embed',
      '--entry-file',
      entryFile,
      '--platform',
      'ios',
      '--dev',
      'false',
      '--bundle-output',
      path.join(app, 'main.jsbundle'),
      '--assets-dest',
      app,
    ],
    {
      timeoutMs: 180_000,
      env: {
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.startsWith('EXPO_PUBLIC_'))
            .map((key) => [key, undefined]),
        ),
        EXPO_PUBLIC_GITHUB_CLIENT_ID: '',
        EXPO_NO_DOTENV: '1',
      },
    },
  );
  await e2e.run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleIdentifier ${bundleId}`,
    path.join(app, 'Info.plist'),
  ]);
  await e2e.run('codesign', ['--deep', '--force', '--sign', '-', app], { timeoutMs: 60_000 });
  await e2e.run('codesign', ['--verify', '--deep', '--strict', app]);
  return app;
}
