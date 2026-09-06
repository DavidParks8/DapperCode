import { createRequire } from 'node:module';
import path from 'node:path';

export const name = 'native-ios-ats';
export const contract = {
  requiredPhases: ['setup', 'baseline', 'trigger', 'broken-state', 'recovery', 'confirmation'],
};

export default async function scenario(e2e) {
  const mobile = path.join(e2e.worktree, 'apps/mobile');
  const sources = path.join(mobile, 'plugins/tests');
  const require = createRequire(path.join(mobile, 'package.json'));
  const policies = {
    control: { NSAllowsArbitraryLoads: true },
    old: {
      NSAllowsArbitraryLoads: false,
      NSAllowsArbitraryLoadsInWebContent: true,
      NSAllowsLocalNetworking: true,
    },
  };
  let simulator;
  let booted = false;
  let server;
  let port;
  let blocked;

  async function launch(variant) {
    const result = await e2e.run(
      'xcrun',
      [
        'simctl',
        'launch',
        '--console',
        simulator,
        `dev.dappercode.ats.${variant}`,
        `http://127.0.0.1.nip.io:${port}/attachments`,
      ],
      { timeoutMs: 45000 },
    );
    const line = result.stdout.split('\n').find((line) => line.startsWith('ATS_RESULT '));
    await e2e.check(`${variant}: native result returned`, () => Boolean(line));
    return JSON.parse(line.slice('ATS_RESULT '.length));
  }

  async function received(count) {
    const result = await e2e.requestHttp({ url: `http://127.0.0.1:${port}/observations` });
    await e2e.expectEqual(
      'server received only valid complete image uploads',
      JSON.parse(result.text),
      {
        attempts: count,
        accepted: count,
      },
    );
  }

  try {
    await e2e.phase('setup', async () => {
      // Introspection executes the actual registered plugin chain without writing the iOS project.
      const config = await e2e.run(
        process.execPath,
        [require.resolve('expo/bin/cli'), 'config', '--type', 'introspect', '--json'],
        { cwd: mobile, env: { EXPO_NO_TELEMETRY: '1' }, timeoutMs: 60000 },
      );
      policies.generated = JSON.parse(
        config.stdout,
      )._internal.modResults.ios.infoPlist.NSAppTransportSecurity;
      await e2e.check('Expo produced an ATS dictionary', () => Boolean(policies.generated));

      const image = e2e.writeFile(
        'data/image.png',
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      server = await e2e.start(
        process.execPath,
        [path.join(sources, 'ats-upload-server.mjs'), image],
        {
          label: 'upload-server',
        },
      );
      const ready = await e2e.waitForLog(server.label, /ATS_LISTENING (\d+)/, { timeoutMs: 15000 });
      port = Number(ready[1]);
      await e2e.check('receiver owns an allocated loopback port', () => port > 0 && port < 65536);
      const sdk = await e2e.run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
      const executable = path.join(e2e.runtimeDir, 'ATSTest');
      await e2e.run(
        'xcrun',
        [
          'swiftc',
          '-parse-as-library',
          '-sdk',
          sdk.stdout.trim(),
          '-target',
          'arm64-apple-ios16.4-simulator',
          path.join(sources, 'ATSTestApp.swift'),
          '-o',
          executable,
        ],
        { timeoutMs: 120000 },
      );

      for (const [variant, policy] of Object.entries(policies)) {
        const app = `runtime/${variant}.app`;
        const plist = e2e.writeFile(
          `${app}/Info.plist`,
          JSON.stringify({
            CFBundleIdentifier: `dev.dappercode.ats.${variant}`,
            CFBundleExecutable: 'ATSTest',
            CFBundleName: 'ATSTest',
            CFBundlePackageType: 'APPL',
            CFBundleVersion: '1',
            CFBundleShortVersionString: '1.0',
            UILaunchScreen: {},
            NSAppTransportSecurity: policy,
          }),
        );
        await e2e.run('plutil', ['-convert', 'xml1', plist]);
        e2e.copyIntoRun(executable, `${app}/ATSTest`);
        e2e.copyIntoRun(image, `${app}/image.png`);
        await e2e.run('codesign', ['--force', '--sign', '-', path.join(e2e.root, app)]);
      }
      const created = await e2e.run('xcrun', [
        'simctl',
        'create',
        e2e.runId,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      ]);
      simulator = created.stdout.trim();
      await e2e.expectMatch(
        'run owns a distinct iOS 26.5 simulator',
        simulator,
        /^[A-F0-9-]{36}$/i,
      );
      await e2e.run('xcrun', ['simctl', 'boot', simulator]);
      booted = true;
      await e2e.run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeoutMs: 120000 });
      for (const variant of Object.keys(policies)) {
        await e2e.run('xcrun', [
          'simctl',
          'install',
          simulator,
          path.join(e2e.runtimeDir, `${variant}.app`),
        ]);
      }
    });
    await e2e.phase('baseline', async () => {
      await e2e.expectEqual(
        'permissive control completes native multipart POST',
        await launch('control'),
        {
          status: 201,
          body: 'image accepted',
        },
      );
      await received(1);
    });
    await e2e.phase('trigger', async () => {
      blocked = await launch('old');
      await e2e.expectEqual('old policy settles without an HTTP response', blocked.status, 0);
    });
    await e2e.phase('broken-state', async () => {
      await e2e.expectEqual('old policy fails specifically with native ATS -1022', blocked, {
        status: 0,
        domain: 'NSURLErrorDomain',
        code: -1022,
      });
      await received(1);
    });
    await e2e.phase('recovery', async () => {
      await e2e.expectEqual(
        'generated app policy completes the same native POST',
        await launch('generated'),
        {
          status: 201,
          body: 'image accepted',
        },
      );
      await received(2);
      await e2e.expectEqual(
        'final Expo ATS policy has no overriding fine-grained keys',
        policies.generated,
        {
          NSAllowsArbitraryLoads: true,
        },
      );
    });
    await e2e.phase('confirmation', async () => {
      await e2e.expectEqual(
        'fresh generated app process can upload again',
        await launch('generated'),
        {
          status: 201,
          body: 'image accepted',
        },
      );
      await received(3);
    });
  } finally {
    try {
      if (simulator) {
        try {
          if (booted)
            await e2e.run('xcrun', ['simctl', 'shutdown', simulator], { timeoutMs: 30000 });
        } finally {
          await e2e.run('xcrun', ['simctl', 'delete', simulator], { timeoutMs: 30000 });
        }
      }
    } finally {
      if (server) await server.stop();
    }
  }
}
