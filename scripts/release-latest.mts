#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
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

function run(command: string, args: ReadonlyArray<string>, cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const status = result.status === null ? 'signal' : String(result.status);
    fail(`${command} ${args.join(' ')} exited with status ${status}`);
  }
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
            'Fast-forward origin/main, rebuild and launch the macOS tray app, then submit a local',
            'iOS production archive to TestFlight.',
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

function buildAndLaunchTray(): void {
  run('npm', ['run', 'desktop:build:macos']);
  run('open', [TRAY_APP]);
  run('sleep', ['2']);

  const pids = capture('pgrep', ['-x', 'DapperCode']);
  if (!pids) fail('DapperCode tray app did not start');
  info(`Tray app running (${pids.split('\n').join(', ')})`);
}

function publishTestFlight(): void {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'dappercode-testflight-'));
  const archivePath = path.join(temporaryDirectory, 'DapperCode.ipa');

  try {
    run(
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
    );
    if (!existsSync(archivePath)) {
      fail(`local EAS build completed without creating ${archivePath}`);
    }

    run(
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
      '  3. Run npm run desktop:build:macos and open the tray app.',
      '  4. Run a local iOS production EAS build.',
      '  5. Submit the generated IPA to TestFlight.',
    ].join('\n'),
  );
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (options.dryRun) {
    printDryRun();
    return;
  }

  ensureSupportedPlatform();
  syncMain();
  buildAndLaunchTray();
  publishTestFlight();
  info('TestFlight submission scheduled; Apple processing may take several minutes.');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
