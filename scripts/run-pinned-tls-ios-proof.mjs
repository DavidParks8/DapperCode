#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatSocketAddress } from './pinned-tls-proof-network.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = join(repoRoot, 'apps', 'mobile');
const iosRoot = join(mobileRoot, 'ios');
const bridgeManifest = join(repoRoot, 'services', 'rust-bridge', 'Cargo.toml');
const bundleIdentifier = 'com.dappermagna.tethercode';
const proofJavaScriptMarker = 'DAPPERCODE_PINNED_TLS_PROOF_JS_ONLY_V1';
const proofSwiftCondition = 'DAPPERCODE_PINNED_TLS_PROOF';
const runDirectory = mkdtempSync(join(tmpdir(), 'dappercode-pinned-tls-proof-'));
const children = new Set();

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    simulator: false,
    device: '',
    tailnetHost: '',
    tailscaleIp: '',
    developmentTeam: process.env.APPLE_TEAM_ID ?? '',
    output: '',
    skipBuild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--simulator') options.simulator = true;
    else if (argument === '--skip-build') options.skipBuild = true;
    else if (argument === '--device')
      options.device = argv[++index] ?? fail('--device needs a value');
    else if (argument === '--tailnet-host')
      options.tailnetHost = argv[++index] ?? fail('--tailnet-host needs a value');
    else if (argument === '--tailscale-ip')
      options.tailscaleIp = argv[++index] ?? fail('--tailscale-ip needs a value');
    else if (argument === '--development-team')
      options.developmentTeam = argv[++index] ?? fail('--development-team needs a value');
    else if (argument === '--output')
      options.output = argv[++index] ?? fail('--output needs a value');
    else fail(`unknown argument ${argument}`);
  }
  if (!options.simulator && !options.device) {
    fail('physical proof usage: --device "<iPhone>" --tailnet-host "<MagicDNS name>"');
  }
  if (!options.simulator && !options.tailnetHost) {
    fail('--tailnet-host is required for a physical proof');
  }
  if (!options.simulator && options.skipBuild) {
    fail('--skip-build is available only for simulator iteration');
  }
  return options;
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

function run(
  command,
  args,
  { cwd = repoRoot, env = {}, allowFailure = false, capture = false } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment(env),
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    fail(`${command} exited with status ${result.status}${detail}`);
  }
  return capture ? String(result.stdout).trim() : '';
}

function start(command, args, { cwd = repoRoot, env = {}, name }) {
  const logPath = join(runDirectory, `${name}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    env: commandEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.once('exit', () => {
    children.delete(child);
    log.end();
  });
  return { child, logPath };
}

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

process.once('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function waitUntil(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`);
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

function generateNativeProject() {
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'ios', '--no-install'], {
    cwd: mobileRoot,
  });
  run(podExecutable(), ['install'], {
    cwd: iosRoot,
    env: { EX_UPDATES_NATIVE_DEBUG: '1' },
  });
  const project = readFileSync(join(iosRoot, 'DapperCode.xcodeproj', 'project.pbxproj'), 'utf8');
  const podfile = readFileSync(join(iosRoot, 'Podfile'), 'utf8');
  const appDelegate = readFileSync(join(iosRoot, 'DapperCode', 'AppDelegate.swift'), 'utf8');
  if (!project.includes('IPHONEOS_DEPLOYMENT_TARGET = 15.1;')) {
    fail('generated Xcode project did not preserve the required iOS 15.1 target');
  }
  if (!podfile.includes("platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'")) {
    fail('generated Podfile did not preserve the required iOS 15.1 target');
  }
  if (
    !appDelegate.includes(`#if ${proofSwiftCondition}`) ||
    !appDelegate.includes('return Bundle.main.url(forResource: "main", withExtension: "jsbundle")')
  ) {
    fail('generated AppDelegate does not support the proof-only embedded JavaScript entry');
  }
}

function selectSimulator() {
  const listing = JSON.parse(
    run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { capture: true }),
  );
  const phones = Object.values(listing.devices)
    .flat()
    .filter((device) => device.isAvailable && device.name.startsWith('iPhone'));
  const selected = phones.find((device) => device.state === 'Booted') ?? phones[0];
  if (!selected) fail('no available iPhone simulator is installed');
  if (selected.state !== 'Booted') {
    run('xcrun', ['simctl', 'boot', selected.udid]);
    run('xcrun', ['simctl', 'bootstatus', selected.udid, '-b']);
  }
  return selected.udid;
}

function buildAndInstall(options, selector) {
  const derivedData = join(runDirectory, 'DerivedData');
  const configuration = 'Debug';
  const destination = options.simulator ? `id=${selector}` : 'generic/platform=iOS';
  const args = [
    '-workspace',
    'DapperCode.xcworkspace',
    '-scheme',
    'DapperCode',
    '-configuration',
    configuration,
    '-destination',
    destination,
    '-derivedDataPath',
    derivedData,
    'build',
    '-quiet',
  ];
  if (!options.simulator) {
    args.splice(args.length - 2, 0, '-allowProvisioningUpdates');
    if (options.developmentTeam)
      args.splice(args.length - 2, 0, `DEVELOPMENT_TEAM=${options.developmentTeam}`);
  }
  args.splice(
    args.length - 2,
    0,
    'ENTRY_FILE=src/proof/PinnedTlsProofEntry.tsx',
    'FORCE_BUNDLING=1',
    'SKIP_BUNDLING_METRO_IP=1',
    `SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) ${proofSwiftCondition}`,
  );
  run('xcodebuild', args, { cwd: iosRoot });
  const platform = options.simulator ? 'iphonesimulator' : 'iphoneos';
  const appPath = join(
    derivedData,
    'Build',
    'Products',
    `${configuration}-${platform}`,
    'DapperCode.app',
  );
  if (!existsSync(appPath)) fail(`built app was not found at ${appPath}`);
  const bundlePath = join(appPath, 'main.jsbundle');
  if (!existsSync(bundlePath)) {
    fail('proof debug app is missing its embedded JavaScript bundle');
  }
  if (!readFileSync(bundlePath).includes(Buffer.from(proofJavaScriptMarker))) {
    fail('proof debug app embedded the wrong JavaScript entry');
  }
  if (existsSync(join(appPath, 'ip.txt'))) {
    fail('proof debug app unexpectedly contains a Metro host hint');
  }

  if (options.simulator) {
    run('xcrun', ['simctl', 'uninstall', selector, bundleIdentifier], { allowFailure: true });
    run('xcrun', ['simctl', 'install', selector, appPath]);
  } else {
    run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', selector, appPath]);
  }
}

function launch(options, selector, environment = {}) {
  const proofEnvironment = {
    DAPPERCODE_PINNED_TLS_PROOF: '1',
    ...environment,
  };
  const argumentsList = ['--dappercode-pinned-tls-proof'];
  if (options.simulator) {
    const simEnvironment = Object.fromEntries(
      Object.entries(proofEnvironment).map(([key, value]) => [
        `SIMCTL_CHILD_${key}`,
        String(value),
      ]),
    );
    run(
      'xcrun',
      [
        'simctl',
        'launch',
        '--terminate-running-process',
        selector,
        bundleIdentifier,
        ...argumentsList,
      ],
      { env: simEnvironment },
    );
    return;
  }
  run('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    selector,
    '--terminate-existing',
    '--environment-variables',
    JSON.stringify(proofEnvironment),
    bundleIdentifier,
    ...argumentsList,
  ]);
}

function simulatorContainer(selector) {
  return run('xcrun', ['simctl', 'get_app_container', selector, bundleIdentifier, 'data'], {
    capture: true,
  });
}

async function readAppReport(options, selector, filename, timeoutMs, runID) {
  if (options.simulator) {
    const path = join(simulatorContainer(selector), 'Documents', filename);
    return await waitUntil(
      () => {
        if (!existsSync(path)) return null;
        const report = JSON.parse(readFileSync(path, 'utf8'));
        return report.runID === runID ? report : null;
      },
      timeoutMs,
      filename,
    );
  }
  const destination = join(runDirectory, filename);
  return await waitUntil(
    () => {
      rmSync(destination, { force: true });
      run(
        'xcrun',
        [
          'devicectl',
          'device',
          'copy',
          'from',
          '--device',
          selector,
          '--source',
          `Documents/${filename}`,
          '--destination',
          destination,
          '--domain-type',
          'appDataContainer',
          '--domain-identifier',
          bundleIdentifier,
          '--quiet',
        ],
        { allowFailure: true },
      );
      if (!existsSync(destination)) return null;
      const report = JSON.parse(readFileSync(destination, 'utf8'));
      return report.runID === runID ? report : null;
    },
    timeoutMs,
    filename,
  );
}

async function startProofServer(options, clientPin, tailscaleIp, caSignedSubstitution = false) {
  const bind = options.simulator ? '127.0.0.1:0' : formatSocketAddress(tailscaleIp, 0);
  const hostname = options.simulator ? 'localhost' : options.tailnetHost;
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    bridgeManifest,
    '--bin',
    'pinned_tls_proof',
    '--',
    'serve',
    '--bind',
    bind,
    '--hostname',
    hostname,
    '--client-pin',
    clientPin,
  ];
  if (options.simulator) args.push('--simulator-loopback');
  if (caSignedSubstitution) args.push('--ca-signed-server-substitution');
  const { child, logPath } = start('cargo', args, {
    name: caSignedSubstitution ? 'rustls-substitution' : 'rustls-proof',
  });
  const events = [];
  const ready = await new Promise((resolveReady, reject) => {
    let buffered = '';
    let resolved = false;
    const timer = setTimeout(
      () => reject(new Error(`server did not become ready; see ${logPath}`)),
      180_000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const parsed = JSON.parse(line);
          events.push(parsed);
          if (parsed.event === 'ready' && !resolved) {
            resolved = true;
            clearTimeout(timer);
            resolveReady(parsed);
          }
        } catch (error) {
          if (!resolved) {
            clearTimeout(timer);
            reject(error);
          }
        }
        newline = buffered.indexOf('\n');
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}; see ${logPath}`));
    });
  });
  return { child, events, ready };
}

function tailscaleAddress(options) {
  if (options.simulator) return '';
  const address =
    options.tailscaleIp ||
    run('tailscale', ['ip', '-4'], {
      capture: true,
    })
      .split(/\s+/)
      .find(Boolean);
  if (!address) fail('no Tailscale IPv4 address is available; pass --tailscale-ip explicitly');
  return address;
}

function writeFinalReport(
  options,
  appReport,
  primaryServer,
  substitutionServer,
  expectedClientPin,
) {
  const acceptedHandshakes = primaryServer.events.filter(
    (event) => event.event === 'acceptedHandshake',
  );
  const serverHandshakeProof =
    acceptedHandshakes.length >= 4 &&
    acceptedHandshakes.every(
      (event) =>
        event.tlsVersion === 'TLS1.3' &&
        event.clientSpkiPin === expectedClientPin &&
        event.certificateVerifyVerified === true,
    );
  const substitutionAcceptedHandshakeCount = substitutionServer.events.filter(
    (event) => event.event === 'acceptedHandshake',
  ).length;
  const serverReady = primaryServer.ready;
  const promptEvidenceIsValid = options.simulator
    ? appReport.promptCount === null && appReport.promptCountSource === 'simulatorNotObserved'
    : appReport.promptCount === 0 && appReport.promptCountSource === 'operatorObserved';
  const softwareProofPassed =
    appReport.httpsPassed === true &&
    appReport.wssPassed === true &&
    appReport.httpsIdentityPresentedWithEmptyCAHints === true &&
    appReport.wssIdentityPresentedWithEmptyCAHints === true &&
    appReport.wrongServerPinRejected === true &&
    appReport.wrongHostnameRejected === true &&
    appReport.caSignedServerSubstitutionRejected === true &&
    appReport.storageClassVerified === true &&
    appReport.accessControlVerified === true &&
    appReport.wrapperRenewalSPKIStable === true &&
    appReport.reconnectPassed === true &&
    promptEvidenceIsValid &&
    serverReady.tlsVersion === 'TLS1.3' &&
    serverReady.ticketsEnabled === false &&
    serverReady.earlyDataEnabled === false &&
    serverHandshakeProof &&
    substitutionAcceptedHandshakeCount === 0;
  const report = {
    schemaVersion: 1,
    mode: options.simulator ? 'simulatorSoftwareFallback' : 'physicalIPhone',
    generatedAt: new Date().toISOString(),
    deploymentTarget: '15.1',
    softwareProofPassed,
    hardwareGatePassed: options.simulator ? false : appReport.hardwareGatePassed === true,
    hardwareGateStatus: options.simulator
      ? 'blocked-simulator-cannot-prove-secure-enclave'
      : appReport.hardwareGatePassed
        ? 'passed'
        : 'failed',
    server: {
      hostname: serverReady.hostname,
      spkiPin: serverReady.serverSpkiPin,
      tlsVersion: serverReady.tlsVersion,
      acceptableCAHintCount: serverReady.acceptableCaHintCount,
      ticketsEnabled: serverReady.ticketsEnabled,
      earlyDataEnabled: serverReady.earlyDataEnabled,
      reachability: serverReady.reachability,
      serverWrapper: serverReady.serverWrapper,
      acceptedHandshakeCount: acceptedHandshakes.length,
      authorizedClientSPKIPin: expectedClientPin,
      certificateVerifyVerified: serverHandshakeProof,
      caSignedSubstitution: {
        serverWrapper: substitutionServer.ready.serverWrapper,
        spkiPin: substitutionServer.ready.serverSpkiPin,
        acceptedHandshakeCount: substitutionAcceptedHandshakeCount,
      },
    },
    device: appReport,
  };
  const output = options.output || join(tmpdir(), `dappercode-pinned-tls-proof-${Date.now()}.json`);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nStructured report: ${output}`);
  if (!softwareProofPassed) process.exitCode = 1;
  if (!options.simulator && !report.hardwareGatePassed) process.exitCode = 2;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runID = randomUUID();
  const selector = options.simulator ? selectSimulator() : options.device;
  const tailscaleIp = tailscaleAddress(options);
  if (!options.skipBuild) {
    generateNativeProject();
    buildAndInstall(options, selector);
  }

  launch(options, selector, { DAPPERCODE_PINNED_TLS_RUN_ID: runID });
  const prepared = await readAppReport(
    options,
    selector,
    'pinned-tls-prepared.json',
    180_000,
    runID,
  );
  if (!prepared.spkiPin) {
    fail('prepared identity report is missing the public client SPKI pin');
  }

  const primaryServer = await startProofServer(options, prepared.spkiPin, tailscaleIp);
  const substitutionServer = await startProofServer(options, prepared.spkiPin, tailscaleIp, true);
  const port = Number(String(primaryServer.ready.bindAddress).match(/:(\d+)$/)?.[1]);
  if (!Number.isInteger(port)) fail('proof server reported an invalid bind address');
  const substitutionPort = Number(
    String(substitutionServer.ready.bindAddress).match(/:(\d+)$/)?.[1],
  );
  if (!Number.isInteger(substitutionPort)) {
    fail('substitution proof server reported an invalid bind address');
  }
  const hostname = options.simulator ? 'localhost' : options.tailnetHost;
  launch(options, selector, {
    DAPPERCODE_PINNED_TLS_HTTPS_URL: `https://${hostname}:${port}/echo`,
    DAPPERCODE_PINNED_TLS_WSS_URL: `wss://${hostname}:${port}/ws/echo`,
    DAPPERCODE_PINNED_TLS_HOSTNAME: hostname,
    DAPPERCODE_PINNED_TLS_SERVER_SPKI: primaryServer.ready.serverSpkiPin,
    DAPPERCODE_PINNED_TLS_SUBSTITUTION_HTTPS_URL: `https://${hostname}:${substitutionPort}/echo`,
    DAPPERCODE_PINNED_TLS_SUBSTITUTION_SERVER_SPKI: substitutionServer.ready.serverSpkiPin,
    DAPPERCODE_PINNED_TLS_PROMPT_COUNT: options.simulator ? '-1' : '',
    DAPPERCODE_PINNED_TLS_PROMPT_COUNT_SOURCE: options.simulator ? 'simulatorNotObserved' : '',
    DAPPERCODE_PINNED_TLS_REQUIRE_NETWORK_TRANSITION: options.simulator ? 'false' : 'true',
    DAPPERCODE_PINNED_TLS_RUN_ID: runID,
  });
  if (!options.simulator) {
    console.log(
      '\nOn the iPhone: tap Run proof, induce one real network transition, return to the app, and record the observed prompt count.',
    );
  }
  const appReport = await readAppReport(
    options,
    selector,
    'pinned-tls-report.json',
    options.simulator ? 240_000 : 12 * 60_000,
    runID,
  );
  writeFinalReport(options, appReport, primaryServer, substitutionServer, prepared.spkiPin);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanup();
  if (process.exitCode === undefined || process.exitCode === 0) {
    rmSync(runDirectory, { recursive: true, force: true });
  } else {
    console.error(`Proof logs retained at ${runDirectory}`);
  }
}
