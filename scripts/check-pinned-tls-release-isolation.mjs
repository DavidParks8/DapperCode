#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = join(repoRoot, 'apps', 'mobile');
const iosRoot = join(mobileRoot, 'ios');
const runDirectory = mkdtempSync(join(tmpdir(), 'dappercode-pinned-tls-release-'));
const jsMarker = 'DAPPERCODE_PINNED_TLS_PROOF_JS_ONLY_V1';
const nativeMarker = 'DapperCodePinnedTlsProof';
const proofSwiftCondition = 'DAPPERCODE_PINNED_TLS_PROOF';
let succeeded = false;

function fail(message) {
  throw new Error(message);
}

function commandEnvironment(extra = {}) {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.bareRepository',
    GIT_CONFIG_VALUE_0: 'all',
    ...extra,
  };
}

function logTail(path, maximumBytes = 12_000) {
  if (!existsSync(path)) return '';
  const output = readFileSync(path, 'utf8');
  return output.slice(Math.max(0, output.length - maximumBytes));
}

function run(
  command,
  args,
  { cwd = repoRoot, env = {}, capture = false, logName = basename(command) } = {},
) {
  if (capture) {
    const result = spawnSync(command, args, {
      cwd,
      env: commandEnvironment(env),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      fail(`${command} exited with status ${result.status}\n${result.stderr || result.stdout}`);
    }
    return String(result.stdout).trim();
  }

  const logPath = join(runDirectory, `${logName}.log`);
  const descriptor = openSync(logPath, 'a', 0o600);
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment(env),
    stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status}; see ${logPath}\n${logTail(logPath)}`);
  }
  return '';
}

function podExecutable() {
  const rubyUserDirectory = run('ruby', ['-e', 'print Gem.user_dir'], { capture: true });
  const userPod = join(rubyUserDirectory, 'bin', 'pod');
  if (existsSync(userPod)) return userPod;
  const gemBin = run('ruby', ['-e', 'print Gem.bindir'], { capture: true });
  const systemPod = join(gemBin, 'pod');
  if (existsSync(systemPod)) return systemPod;
  fail('CocoaPods is unavailable; run `gem install --user-install cocoapods`');
}

function createBundle(entryFile, name) {
  const bundle = join(runDirectory, `${name}.jsbundle`);
  const sourceMap = join(runDirectory, `${name}.map`);
  run(
    process.execPath,
    [
      join(mobileRoot, 'scripts', 'run-expo.cjs'),
      'export:embed',
      '--entry-file',
      entryFile,
      '--platform',
      'ios',
      '--dev',
      'false',
      '--minify',
      'true',
      '--bundle-output',
      bundle,
      '--sourcemap-output',
      sourceMap,
      '--assets-dest',
      join(runDirectory, `${name}-assets`),
    ],
    {
      cwd: mobileRoot,
      env: { NODE_ENV: 'production' },
      logName: `${name}-bundle`,
    },
  );
  return { bundle, sourceMap };
}

function sourceContainsProof(source) {
  const normalized = source.replaceAll('\\', '/');
  return (
    normalized.includes('src/proof/') || normalized.includes('modules/dappercode-pinned-tls-proof/')
  );
}

function verifyJavaScriptIsolation() {
  const production = createBundle('index.js', 'production');
  const proof = createBundle('src/proof/PinnedTlsProofEntry.tsx', 'proof');
  const productionBundle = readFileSync(production.bundle);
  const proofBundle = readFileSync(proof.bundle);
  if (!proofBundle.includes(Buffer.from(jsMarker))) {
    fail('proof bundle does not contain the release-isolation marker');
  }
  if (productionBundle.includes(Buffer.from(jsMarker))) {
    fail('production Release bundle contains the pinned TLS proof marker');
  }

  const productionMap = JSON.parse(readFileSync(production.sourceMap, 'utf8'));
  const proofSources = (productionMap.sources ?? []).filter(sourceContainsProof);
  if (proofSources.length > 0) {
    fail(`production Release graph contains proof sources: ${proofSources.join(', ')}`);
  }
  return {
    markerAbsent: true,
    proofSourcesAbsent: true,
  };
}

function listPaths(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory()
      ? [relative, ...listPaths(join(root, entry.name), relative)]
      : [relative];
  });
}

function verifyNativeReleaseIsolation() {
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'ios', '--no-install'], {
    cwd: mobileRoot,
    logName: 'prebuild',
  });
  run(podExecutable(), ['install'], {
    cwd: iosRoot,
    env: { EX_UPDATES_NATIVE_DEBUG: '0' },
    logName: 'pods',
  });

  const autolinking = JSON.parse(
    run('npx', ['expo-modules-autolinking', 'resolve', '--platform', 'apple', '--json'], {
      cwd: mobileRoot,
      capture: true,
    }),
  );
  const proofModule = (autolinking.modules ?? []).find(
    (module) => module.packageName === 'dappercode-pinned-tls-proof',
  );
  if (proofModule?.debugOnly !== true) {
    fail('native proof module is not marked debugOnly by Expo autolinking');
  }

  const supportRoot = join(iosRoot, 'Pods', 'Target Support Files', 'Pods-DapperCode');
  const debugConfig = readFileSync(join(supportRoot, 'Pods-DapperCode.debug.xcconfig'), 'utf8');
  const releaseConfig = readFileSync(join(supportRoot, 'Pods-DapperCode.release.xcconfig'), 'utf8');
  if (!debugConfig.includes(nativeMarker)) {
    fail('Debug Pods configuration does not link the native proof module');
  }
  if (releaseConfig.includes(nativeMarker)) {
    fail('Release Pods configuration links the native proof module');
  }

  const provider = readFileSync(join(supportRoot, 'ExpoModulesProvider.swift'), 'utf8');
  if (!provider.includes(`#if EXPO_CONFIGURATION_DEBUG\ninternal import ${nativeMarker}\n#endif`)) {
    fail(
      'Expo module provider does not guard the native proof import with the Debug configuration',
    );
  }
  const appDelegate = readFileSync(join(iosRoot, 'DapperCode', 'AppDelegate.swift'), 'utf8');
  if (
    !appDelegate.includes(`#if ${proofSwiftCondition}`) ||
    !appDelegate.includes('return Bundle.main.url(forResource: "main", withExtension: "jsbundle")')
  ) {
    fail('generated AppDelegate does not compile-gate the embedded proof entry');
  }

  const derivedData = join(runDirectory, 'DerivedData');
  run(
    'xcodebuild',
    [
      '-workspace',
      'DapperCode.xcworkspace',
      '-scheme',
      'DapperCode',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derivedData,
      'CODE_SIGNING_ALLOWED=NO',
      'build',
      '-quiet',
    ],
    { cwd: iosRoot, logName: 'release-build' },
  );

  const app = join(derivedData, 'Build', 'Products', 'Release-iphonesimulator', 'DapperCode.app');
  const executable = join(app, 'DapperCode');
  const bundle = join(app, 'main.jsbundle');
  if (!existsSync(executable) || !existsSync(bundle)) {
    fail('Release app did not contain its executable and embedded JavaScript bundle');
  }
  const forbiddenArtifacts = listPaths(app).filter((path) => path.includes(nativeMarker));
  if (forbiddenArtifacts.length > 0) {
    fail(`Release app contains native proof artifacts: ${forbiddenArtifacts.join(', ')}`);
  }
  const executableData = readFileSync(executable);
  const bundleData = readFileSync(bundle);
  for (const marker of [
    nativeMarker,
    jsMarker,
    proofSwiftCondition,
    'com.dappercode.pinned-tls-proof',
  ]) {
    const encoded = Buffer.from(marker);
    if (executableData.includes(encoded) || bundleData.includes(encoded)) {
      fail(`Release app contains pinned TLS proof marker ${marker}`);
    }
  }
  return {
    autolinkingDebugOnly: true,
    embeddedEntryCompileGuarded: true,
    debugPodLinked: true,
    releasePodAbsent: true,
    releaseArtifactsAbsent: true,
    releaseExecutableMarkersAbsent: true,
  };
}

try {
  if (process.platform !== 'darwin') {
    fail('native Release-isolation validation requires macOS and Xcode');
  }
  const report = {
    schemaVersion: 1,
    productionJavaScript: verifyJavaScriptIsolation(),
    nativeRelease: verifyNativeReleaseIsolation(),
  };
  console.log(JSON.stringify(report, null, 2));
  succeeded = true;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (succeeded) {
    rmSync(runDirectory, { recursive: true, force: true });
  } else {
    console.error(`Release-isolation logs retained at ${runDirectory}`);
  }
}
