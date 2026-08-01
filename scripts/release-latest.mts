#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = path.join(ROOT, 'apps/mobile');
const TRAY_APP = path.join(ROOT, 'apps/desktop/dist/DapperCode.app');

type Options = {
  dryRun: boolean;
};

function fail(message: string): never {
  throw new Error(message);
}

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

function formatCommand(command: string, args: ReadonlyArray<string>): string {
  return `${command} ${args.join(' ')}`;
}

function run(command: string, args: ReadonlyArray<string>, cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const status = result.status === null ? 'signal' : String(result.status);
    fail(`${formatCommand(command, args)} exited with status ${status}`);
  }
}

function runAsync(
  command: string,
  args: ReadonlyArray<string>,
  cwd = ROOT,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, stdio: 'inherit' });

    child.once('error', reject);
    child.once('close', (status, signalName) => {
      if (status === 0) {
        resolve();
        return;
      }
      if (signalName !== null) {
        reject(new Error(`${formatCommand(command, args)} exited due to signal ${signalName}`));
        return;
      }
      reject(new Error(`${formatCommand(command, args)} exited with status ${status ?? 'signal'}`));
    });
  });
}

function capture(command: string, args: ReadonlyArray<string>, cwd = ROOT): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  const options: Options = { dryRun: false };

  for (const argument of argv) {
    switch (argument) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        info(
          [
            'Usage: npm run release:latest',
            '',
            'Fast-forward origin/main, then in parallel rebuild and launch the macOS tray app',
            'while preparing and submitting a local iOS production archive to TestFlight.',
            '',
            'Options:',
            '  --dry-run  Print the release steps without changing the checkout or building',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument '${argument}'`);
    }
  }

  return options;
}

function ensureSupportedPlatform(): void {
  if (process.platform !== 'darwin') {
    fail('release:latest must run on macOS because it builds and launches the tray app');
  }
}

function ensureTrackedTreeClean(): void {
  const result = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail('tracked working-tree changes are present; commit or remove them before releasing');
  }
}

function syncMain(): string {
  ensureTrackedTreeClean();
  run('git', ['fetch', 'origin', 'main', '--quiet']);
  run('git', ['merge', '--ff-only', 'origin/main']);

  const head = capture('git', ['rev-parse', 'HEAD']);
  const remoteHead = capture('git', ['rev-parse', 'origin/main']);
  if (head !== remoteHead) {
    fail(`checkout does not match origin/main (${head} != ${remoteHead})`);
  }

  info(`Using origin/main @ ${head.slice(0, 7)}`);
  return head;
}

async function buildAndLaunchTray(signal: AbortSignal): Promise<void> {
  await runAsync('npm', ['run', 'desktop:build:macos'], ROOT, signal);
  await runAsync('open', [TRAY_APP], ROOT, signal);
  await runAsync('sleep', ['2'], ROOT, signal);

  const pids = capture('pgrep', ['-x', 'DapperCode']);
  if (!pids) fail('DapperCode tray app did not start');
  info(`Tray app running (${pids.split('\n').join(', ')})`);
}

async function publishTestFlight(signal: AbortSignal): Promise<void> {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'dappercode-testflight-'));
  const archivePath = path.join(temporaryDirectory, 'DapperCode.ipa');

  try {
    await runAsync(
      'npx',
      [
        '--yes',
        'eas-cli',
        'build',
        '--platform',
        'ios',
        '--profile',
        'production',
        '--non-interactive',
        '--local',
        '--output',
        archivePath,
      ],
      MOBILE_DIR,
      signal,
    );
    if (!existsSync(archivePath)) {
      fail(`local EAS build completed without creating ${archivePath}`);
    }

    await runAsync(
      'npx',
      [
        '--yes',
        'eas-cli',
        'submit',
        '--platform',
        'ios',
        '--profile',
        'production',
        '--path',
        archivePath,
        '--non-interactive',
      ],
      MOBILE_DIR,
      signal,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function printDryRun(): void {
  info(
    [
      'Dry run. Would:',
      '  1. Verify tracked changes are clean.',
      '  2. Fetch and fast-forward to origin/main.',
      '  3. In parallel, run npm run desktop:build:macos, open the tray app, and start',
      '     a local iOS production EAS build.',
      '  4. Submit the generated IPA to TestFlight.',
    ].join('\n'),
  );
}

async function runReleaseTasksInParallel(): Promise<void> {
  const controller = new AbortController();
  let failure: unknown;

  const wrapTask = async (task: Promise<void>): Promise<void> => {
    try {
      await task;
    } catch (error) {
      if (failure === undefined) {
        failure = error;
        controller.abort();
      }
      throw error;
    }
  };

  await Promise.allSettled([
    wrapTask(buildAndLaunchTray(controller.signal)),
    wrapTask(publishTestFlight(controller.signal)),
  ]);

  if (failure !== undefined) {
    throw failure;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.dryRun) {
    printDryRun();
    return;
  }

  ensureSupportedPlatform();
  syncMain();
  await runReleaseTasksInParallel();
  info('TestFlight submission scheduled; Apple processing may take several minutes.');
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
