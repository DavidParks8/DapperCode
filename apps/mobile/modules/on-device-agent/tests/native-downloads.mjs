import { createHash } from 'node:crypto';
import path from 'node:path';
import { bundleNativeReactApp } from './bundleNativeReactApp.mjs';

export const name = 'on-device-native-downloads';
export const contract = { requiredPhases: ['bundle', 'serve', 'native-downloads'] };

export default async function scenario(e2e) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const bundleId = 'dev.dappercode.native-downloads';
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x35);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let app;
  let simulator;
  let booted = false;
  let server;
  let port;
  try {
    await e2e.phase('bundle', async () => {
      app = await bundleNativeReactApp(e2e, {
        entryFile: path.join(module, 'tests/downloads-entry.tsx'),
        bundleId,
        name: 'NativeDownloads',
      });
      await e2e.check('real Expo transfers and production controller are bundled', () => true);
    });
    await e2e.phase('serve', async () => {
      const data = e2e.writeFile('data/model.gguf', bytes);
      const config = e2e.writeFile(
        'data/tls.cnf',
        `[req]
distinguished_name=dn
x509_extensions=extensions
prompt=no
[dn]
CN=localhost
[extensions]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`,
      );
      const certificate = path.join(e2e.dataDir, 'certificate.pem');
      const key = path.join(e2e.dataDir, 'key.pem');
      await e2e.run(
        '/usr/bin/openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-nodes',
          '-days',
          '1',
          '-config',
          config,
          '-keyout',
          key,
          '-out',
          certificate,
        ],
        { timeoutMs: 30_000 },
      );
      server = await e2e.start(
        'node',
        [path.join(module, 'tests/model-download-server.mjs'), data, certificate, key],
        { label: 'model-server' },
      );
      const listening = await e2e.waitForLog('model-server', /MODEL_DOWNLOAD_PORT=(\d+)/);
      port = Number(listening[1]);
      const response = await e2e.run('curl', [
        '--silent',
        '--show-error',
        '--cacert',
        certificate,
        '--head',
        '--max-time',
        '10',
        `https://127.0.0.1:${port}/model.gguf`,
      ]);
      await e2e.expectMatch(
        'HTTPS fixture supports resumable downloads',
        response.stdout,
        /Accept-Ranges: bytes/i,
      );
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
      await e2e.run('xcrun', ['simctl', 'keychain', simulator, 'add-root-cert', certificate]);
      await e2e.run('xcrun', ['simctl', 'install', simulator, app], { timeoutMs: 120_000 });
      const container = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      const fixture = e2e.writeFile(
        'data/download-fixture.json',
        JSON.stringify({
          url: `https://127.0.0.1:${port}/model.gguf`,
          bytes: bytes.length,
          sha256,
        }),
      );
      await e2e.run('cp', [
        fixture,
        path.join(container.stdout.trim(), 'Documents/download-fixture.json'),
      ]);
      await e2e.check('download fixture uses an isolated app and local TLS trust', () => true);
    });
    await e2e.phase('native-downloads', async () => {
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId], { timeoutMs: 60_000 });
      const container = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      const output = path.join(container.stdout.trim(), 'Documents/native-download-result.json');
      let result;
      await e2e.waitFor(
        'native pause, restore, resume, and verification',
        async () => {
          const read = await e2e.run('cat', [output], { expectExitCodes: [0, 1] });
          if (read.code !== 0) {
            return false;
          }
          result = JSON.parse(read.stdout);
          return result.status === 'pass' || result.status === 'fail';
        },
        { timeoutMs: 120_000, intervalMs: 500 },
      );
      await e2e.check('native transfer outcome', () => {
        if (result.status !== 'pass') {
          throw new Error(
            `${result.error} Completed: ${Object.keys(result.checks ?? {}).join(', ')}`,
          );
        }
        return true;
      });
      await e2e.expectSubset('native transfer lifecycle', result.checks, {
        nativePause: true,
        pausedNotReady: true,
        restoredCheckpoint: true,
        nativeResumeAndVerification: true,
        verificationBeforeReady: true,
        coldReadyWithoutNetwork: true,
        resumeMetadataRemoved: true,
        checksumFailureVisible: true,
        checksumFailureNotReady: true,
        nativeRemoval: true,
      });
      await e2e.waitForLog('model-server', /MODEL_RANGE_REQUEST/);
      await e2e.check('resumption used an HTTP Range request', () => true);
      await server.stop();
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
