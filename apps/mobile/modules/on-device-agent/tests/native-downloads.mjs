import { createHash } from 'node:crypto';
import path from 'node:path';
import { bundleNativeReactApp } from './bundleNativeReactApp.mjs';

export const name = 'on-device-native-downloads';
export const contract = { requiredPhases: ['bundle', 'serve', 'native-downloads'] };

export default async function scenario(e2e) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const bundleId = 'dev.dappercode.native-downloads';
  // Large enough (about 15 s per transfer at the fixture's rate) to outlive app termination.
  const bytes = Buffer.alloc(12 * 1024 * 1024, 0x35);
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
      await e2e.check(
        'native background transfers and production controller are bundled',
        () => true,
      );
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
          secondUrl: `https://127.0.0.1:${port}/model-2.gguf`,
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
      const container = await e2e.run('xcrun', [
        'simctl',
        'get_app_container',
        simulator,
        bundleId,
        'data',
      ]);
      const documents = path.join(container.stdout.trim(), 'Documents');
      const readOutcome = async (file) => {
        const read = await e2e.run('cat', [path.join(documents, file)], {
          expectExitCodes: [0, 1],
        });
        return read.code === 0 ? JSON.parse(read.stdout) : null;
      };
      const requireOutcome = (result, expected) => {
        if (result.status !== expected) {
          throw new Error(
            `${result.error} Completed: ${Object.keys(result.checks ?? {}).join(', ')}`,
          );
        }
        return true;
      };
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId], { timeoutMs: 60_000 });
      let first;
      await e2e.waitFor(
        'concurrent transfers, independent pause, and resume',
        async () => {
          first = await readOutcome('native-download-phase-a.json');
          return first !== null;
        },
        { timeoutMs: 120_000, intervalMs: 250 },
      );
      await e2e.check('first launch outcome', () => requireOutcome(first, 'terminate'));
      await e2e.expectSubset('parallel transfer lifecycle', first.checks, {
        downloadResolvesWhenStarted: true,
        secondStartsInParallel: true,
        concurrentNativeTransfers: true,
        nativePause: true,
        pausedNotReady: true,
        pausingOneLeavesOtherRunning: true,
        restoredCheckpoint: true,
        nativeResume: true,
        speedAndEta: true,
        transfersStillRunningAtTermination: true,
      });
      // Terminating (not force-quitting) leaves the background URL session running.
      await e2e.run('xcrun', ['simctl', 'terminate', simulator, bundleId]);
      await e2e.waitFor(
        'both transfers finish while the app is not running',
        () => {
          const log = e2e.readFile('logs/model-server.stdout.log');
          return (
            log.includes('MODEL_RESPONSE_COMPLETE /model.gguf') &&
            log.includes('MODEL_RESPONSE_COMPLETE /model-2.gguf')
          );
        },
        { timeoutMs: 120_000, intervalMs: 500 },
      );
      let events = '';
      await e2e.waitFor(
        'iOS relaunches the app to deliver finished transfers',
        async () => {
          const shown = await e2e.run('xcrun', [
            'simctl',
            'spawn',
            simulator,
            'log',
            'show',
            '--style',
            'compact',
            '--last',
            '10m',
            '--predicate',
            'subsystem == "dev.dappercode.on-device-agent"',
          ]);
          events = shown.stdout;
          return events.includes('MODEL_DOWNLOAD_EVENTS_COMPLETED');
        },
        { timeoutMs: 120_000, intervalMs: 2_000 },
      );
      await e2e.expectMatch(
        'the system background-session completion handler is released',
        events,
        /MODEL_DOWNLOAD_EVENTS_COMPLETED system completion handler called/,
      );
      await e2e.run('xcrun', ['simctl', 'launch', simulator, bundleId], { timeoutMs: 60_000 });
      let result;
      await e2e.waitFor(
        'relaunch re-attachment, verification, and removal',
        async () => {
          result = await readOutcome('native-download-result.json');
          return result !== null;
        },
        { timeoutMs: 240_000, intervalMs: 500 },
      );
      await e2e.check('relaunch outcome', () => requireOutcome(result, 'pass'));
      await e2e.expectSubset('background transfer lifecycle', result.checks, {
        'reattached:native-download-first': true,
        'reattached:native-download-second': true,
        'survivedTermination:native-download-first': true,
        'survivedTermination:native-download-second': true,
        verificationBeforeReady: true,
        coldReadyWithoutNetwork: true,
        transferStateCleared: true,
        checksumFailureVisible: true,
        checksumFailureNotReady: true,
        checksumFailureDiscardsStagedFile: true,
        pauseFailureReleasesTransfer: true,
        pauseFailureCanRestart: true,
        pauseFailureCancelled: true,
        storageOverview: true,
        nativeRemoval: true,
      });
      await e2e.waitForLog('model-server', /MODEL_RANGE_REQUEST/);
      await e2e.check('resumption used an HTTP Range request', () => true);
      const requests = e2e.readFile('logs/model-server.stdout.log');
      await e2e.expectEqual(
        'the unpaused transfer was never restarted across termination',
        requests.match(/MODEL_REQUEST GET \/model-2\.gguf/g)?.length,
        1,
      );
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
