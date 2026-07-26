#!/usr/bin/env node
/**
 * Repeatable TestFlight (and Play) release flow.
 *
 * Wraps the EAS build and submit steps behind a single command so a release is not a sequence of
 * remembered flags. Runs preflight checks first, because the most common way to ship the wrong
 * thing is to build from a dirty or unexpected working tree: EAS archives the *local* git state,
 * not whatever is on the remote.
 *
 * Usage:
 *   npm run release:testflight
 *   npm run release:testflight -- --dry-run
 *   npm run release:testflight -- --platform android --profile preview --no-submit
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = path.join(ROOT, 'apps/mobile');
const EXPECTED_ACCOUNT = 'davidparks8s-team';

type Platform = 'ios' | 'android' | 'all';

type Options = {
  platform: Platform;
  profile: string;
  submit: boolean;
  wait: boolean;
  allowDirty: boolean;
  dryRun: boolean;
};

type EasBuild = {
  id: string;
  status: string;
  platform: string;
  appVersion?: string;
  appBuildVersion?: string;
  gitCommitHash?: string;
  artifacts?: { buildUrl?: string };
};

const PLATFORMS: ReadonlyArray<Platform> = ['ios', 'android', 'all'];

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  const options: Options = {
    platform: 'ios',
    profile: 'production',
    submit: true,
    wait: true,
    allowDirty: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--platform': {
        const value = argv[(index += 1)];
        if (!PLATFORMS.includes(value as Platform)) {
          fail(`--platform must be one of ${PLATFORMS.join(', ')}`);
        }
        options.platform = value as Platform;
        break;
      }
      case '--profile': {
        const value = argv[(index += 1)];
        if (!value) fail('--profile requires a value');
        options.profile = value;
        break;
      }
      case '--no-submit':
        options.submit = false;
        break;
      case '--no-wait':
        options.wait = false;
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        info(
          [
            'Usage: npm run release:testflight -- [options]',
            '',
            'Options:',
            '  --platform ios|android|all   Target platform (default: ios)',
            '  --profile <name>             EAS build profile (default: production)',
            '  --no-submit                  Build without submitting to the store',
            '  --no-wait                    Queue the build and exit immediately',
            '  --allow-dirty                Release from an uncommitted working tree',
            '  --dry-run                    Run preflight checks and print the command only',
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

function run(command: string, args: ReadonlyArray<string>, cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryRun(command: string, args: ReadonlyArray<string>, cwd: string): string | null {
  try {
    return run(command, args, cwd);
  } catch {
    return null;
  }
}

/** Confirms the requested profile exists, and that submitting is actually configured. */
function checkEasConfiguration(options: Options): void {
  const easConfigPath = path.join(MOBILE_DIR, 'eas.json');
  const easConfig = JSON.parse(readFileSync(easConfigPath, 'utf8')) as {
    build?: Record<string, unknown>;
    submit?: Record<string, { ios?: { ascAppId?: string } }>;
  };

  if (!easConfig.build?.[options.profile]) {
    fail(`eas.json has no build profile named '${options.profile}'`);
  }

  if (options.submit && options.platform !== 'android') {
    const ascAppId = easConfig.submit?.[options.profile]?.ios?.ascAppId;
    if (!ascAppId) {
      fail(
        `eas.json has no submit.${options.profile}.ios.ascAppId, so the build cannot reach TestFlight`,
      );
    }
    info(`App Store Connect app: ${ascAppId}`);
  }
}

function checkAuthentication(): void {
  const whoami = tryRun('npx', ['eas-cli', 'whoami', '--non-interactive'], MOBILE_DIR);
  if (whoami === null) {
    fail("not signed in to EAS; run 'npx eas-cli login' from apps/mobile");
  }
  if (!whoami.includes(EXPECTED_ACCOUNT)) {
    fail(`signed-in EAS account cannot access ${EXPECTED_ACCOUNT}:\n${whoami.trim()}`);
  }
  info(`EAS account: ${EXPECTED_ACCOUNT}`);
}

/**
 * EAS uploads the local git state, so a dirty tree silently ships uncommitted work and produces a
 * build nobody can reproduce from a commit.
 */
function checkWorkingTree(options: Options): void {
  const status = run('git', ['status', '--porcelain'], ROOT).trim();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], ROOT).trim();
  const commit = run('git', ['rev-parse', '--short', 'HEAD'], ROOT).trim();

  if (status.length > 0) {
    if (!options.allowDirty) {
      fail(
        `working tree has uncommitted changes, which would be built but not recorded in a commit.\n${status}\nCommit them, or pass --allow-dirty if that is intentional.`,
      );
    }
    info('warning: releasing from a dirty working tree (--allow-dirty)');
  }

  info(`Releasing ${branch} @ ${commit}`);
}

function latestBuild(platform: Platform): EasBuild | null {
  const requested = platform === 'all' ? 'ios' : platform;
  const output = tryRun(
    'npx',
    [
      'eas-cli',
      'build:list',
      '--platform',
      requested,
      '--limit',
      '1',
      '--json',
      '--non-interactive',
    ],
    MOBILE_DIR,
  );
  if (output === null) return null;

  const builds = JSON.parse(output) as ReadonlyArray<EasBuild>;
  return builds[0] ?? null;
}

function buildArguments(options: Options): Array<string> {
  const args = [
    'eas-cli',
    'build',
    '--platform',
    options.platform,
    '--profile',
    options.profile,
    '--non-interactive',
  ];
  if (options.submit) args.push('--auto-submit');
  if (!options.wait) args.push('--no-wait');
  return args;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));

  info(`Platform: ${options.platform} · profile: ${options.profile}`);
  checkEasConfiguration(options);
  checkWorkingTree(options);
  if (!options.dryRun) {
    checkAuthentication();
  }

  const args = buildArguments(options);
  if (options.dryRun) {
    info(`\nDry run. Would execute from apps/mobile:\n  npx ${args.join(' ')}`);
    return;
  }

  info(`\nnpx ${args.join(' ')}\n`);
  const result = spawnSync('npx', args, { cwd: MOBILE_DIR, stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`eas build exited with status ${String(result.status ?? 'unknown')}`);
  }

  if (!options.wait) {
    info('\nBuild queued. Track it with: npx eas-cli build:list --limit 5');
    return;
  }

  const build = latestBuild(options.platform);
  if (build) {
    info('\nRelease summary');
    info(`  build      ${build.id}`);
    info(`  status     ${build.status}`);
    info(`  version    ${build.appVersion ?? 'unknown'} (${build.appBuildVersion ?? 'unknown'})`);
    if (build.artifacts?.buildUrl) info(`  artifact   ${build.artifacts.buildUrl}`);
  }
  if (options.submit) {
    info('\nSubmitted to the store. TestFlight processing takes a few more minutes.');
  }
}

main();
