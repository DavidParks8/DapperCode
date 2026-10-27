import path from 'node:path';
import { nativeTestPlist } from './nativeTestPlist.mjs';

export const name = 'on-device-native-git';
export const contract = { requiredPhases: ['build', 'serve', 'native-git', 'remote-confirmation'] };

export default async function scenario(e2e) {
  const module = path.join(e2e.worktree, 'apps/mobile/modules/on-device-agent');
  const library = path.join(module, 'ios/build/git/libgit2.xcframework/ios-arm64_x86_64-simulator');
  const app = path.join(e2e.runtimeDir, 'NativeGit.app');
  const bundleId = 'dev.dappercode.native-git';
  const username = 'native-fixture';
  const password = e2e.createSecret();
  const remote = path.join(e2e.workspaceDir, 'remote.git');
  const seed = path.join(e2e.workspaceDir, 'seed');
  const gitEnvironment = {
    HOME: e2e.dataDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_TEMPLATE_DIR: undefined,
  };
  const git = (args) => e2e.run('git', args, { env: gitEnvironment });
  let simulator;
  let booted = false;
  let server;
  let port;
  try {
    await e2e.phase('build', async () => {
      e2e.writeFile('runtime/NativeGit.app/Info.plist', nativeTestPlist(bundleId, 'NativeGit'));
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
          path.join(module, 'ios/GitCredentialStore.swift'),
          path.join(module, 'ios/NativeGit.swift'),
          path.join(module, 'ios/GitNetworkOperation.swift'),
          path.join(module, 'ios/NativeGitRead.swift'),
          path.join(module, 'ios/NativeGitMutations.swift'),
          path.join(module, 'tests/NativeGitTestApp.swift'),
          path.join(module, 'tests/NativeTestHost.swift'),
          '-o',
          path.join(app, 'NativeGit'),
        ],
        { timeoutMs: 60_000, env: { SDKROOT: sdk.stdout.trim() } },
      );
      await e2e.run('codesign', ['--force', '--sign', '-', app]);
      await e2e.check('native app links the production Git implementation', () => true);
    });
    await e2e.phase('serve', async () => {
      await git(['init', '--bare', '--initial-branch=main', remote]);
      await git(['init', '--initial-branch=main', seed]);
      e2e.writeFile('workspace/seed/hello.txt', 'ORIGINAL\n');
      e2e.writeFile('workspace/seed/delete.txt', 'DELETE_ME\n');
      await git(['-C', seed, 'add', '.']);
      await git([
        '-C',
        seed,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'seed',
      ]);
      await git(['-C', seed, 'branch', 'feature']);
      await git(['-C', seed, 'push', '--all', remote]);
      await git(['--git-dir', remote, 'config', 'http.receivepack', 'true']);
      const denied = e2e.writeFile('data/reject-next', '1');
      const hook = e2e.writeFile(
        'workspace/remote.git/hooks/pre-receive',
        `#!/bin/sh
if test -f ${JSON.stringify(denied)}; then
  rm ${JSON.stringify(denied)}
  printf 'fixture rejection: %s\\n' "$NATIVE_GIT_PASSWORD" >&2
  exit 1
fi
`,
        { mode: 0o700 },
      );
      await e2e.run('chmod', ['700', hook]);
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
      const key = path.join(e2e.dataDir, 'private-key.pem');
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
        [path.join(module, 'tests/git-https-server.mjs'), e2e.workspaceDir, certificate, key],
        {
          label: 'git-https',
          env: { ...gitEnvironment, NATIVE_GIT_USER: username, NATIVE_GIT_PASSWORD: password },
        },
      );
      const listening = await e2e.waitForLog('git-https', /NATIVE_GIT_PORT=(\d+)/);
      port = Number(listening[1]);
      const response = await e2e.run('curl', [
        '--silent',
        '--show-error',
        '--cacert',
        certificate,
        '--max-time',
        '10',
        '--output',
        path.join(e2e.logDir, 'ready-body'),
        '--write-out',
        '%{http_code}',
        `https://127.0.0.1:${port}/remote.git/info/refs?service=git-upload-pack`,
      ]);
      await e2e.expectEqual('TLS server requires authentication', response.stdout, '401');
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
      await e2e.check('TLS trust is installed only in the disposable simulator', () => true);
    });
    await e2e.phase('native-git', async () => {
      const result = await e2e.run(
        'xcrun',
        ['simctl', 'launch', '--console', simulator, bundleId],
        {
          timeoutMs: 120_000,
          env: {
            SIMCTL_CHILD_NATIVE_GIT_USER: username,
            SIMCTL_CHILD_NATIVE_GIT_PASSWORD: password,
            SIMCTL_CHILD_NATIVE_GIT_URL: `https://127.0.0.1:${port}/remote.git`,
          },
        },
      );
      await e2e.expectMatch('native authenticated Git sequence', result.stdout, /NATIVE_GIT_PASS/);
      for (const line of result.stdout.split('\n').filter((line) => line.startsWith('PASS: '))) {
        await e2e.expectMatch(line.slice(6), line, /^PASS: /);
      }
    });
    await e2e.phase('remote-confirmation', async () => {
      const edited = await git(['--git-dir', remote, 'show', 'main:hello.txt']);
      await e2e.expectEqual('pushed file contents', edited.stdout, 'NATIVE_GIT_CHANGED\n');
      const literal = await git(['--git-dir', remote, 'show', 'main:[literal].txt']);
      await e2e.expectEqual('literal path was staged', literal.stdout, 'LITERAL\n');
      const tree = await git(['--git-dir', remote, 'ls-tree', '--name-only', 'main']);
      await e2e.check(
        'deleted and untracked files were not pushed',
        () => !tree.stdout.includes('delete.txt') && !tree.stdout.includes('other.txt'),
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
