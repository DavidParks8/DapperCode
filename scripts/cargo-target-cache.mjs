import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CACHE_LAYOUT_VERSION = 'v1';
const MANAGED_ENTRY_PATTERN = /^[a-f0-9]{24}$/;

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  const canonical = existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function cacheKey(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function defaultCacheRoot(env) {
  if (env.DAPPERCODE_CARGO_TARGET_ROOT) {
    return path.resolve(env.DAPPERCODE_CARGO_TARGET_ROOT);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'dev.dappercode.build', 'cargo-targets');
  }
  if (process.platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'DapperCode',
      'cargo-targets',
    );
  }
  return path.join(
    env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'dappercode',
    'cargo-targets',
  );
}

function registeredWorktreeRoots(cwd) {
  return gitOutput(cwd, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
    .filter((worktreePath) => existsSync(worktreePath))
    .map(canonicalPath);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function hasActiveLease(entryPath) {
  const leasesPath = path.join(entryPath, 'leases');
  if (!existsSync(leasesPath)) return false;

  let active = false;
  for (const lease of readdirSync(leasesPath, { withFileTypes: true })) {
    if (!lease.isFile() || !lease.name.endsWith('.json')) continue;
    const leasePath = path.join(leasesPath, lease.name);
    try {
      const { pid } = JSON.parse(readFileSync(leasePath, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && processIsRunning(pid)) {
        active = true;
      } else {
        rmSync(leasePath, { force: true });
      }
    } catch {
      rmSync(leasePath, { force: true });
    }
  }
  return active;
}

function pruneRemovedWorktrees(entriesPath, activeKeys) {
  if (!existsSync(entriesPath)) return;
  for (const entry of readdirSync(entriesPath, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !MANAGED_ENTRY_PATTERN.test(entry.name) ||
      activeKeys.has(entry.name)
    ) {
      continue;
    }
    const entryPath = path.join(entriesPath, entry.name);
    if (!hasActiveLease(entryPath)) {
      rmSync(entryPath, { recursive: true, force: true });
    }
  }
}

function managedTargetsEnabled(env) {
  if (env.DAPPERCODE_MANAGED_CARGO_TARGETS === '0') return false;
  return !env.CI || env.DAPPERCODE_MANAGED_CARGO_TARGETS === '1';
}

export function prepareCargoTarget(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  if (!managedTargetsEnabled(env) || env.CARGO_TARGET_DIR) {
    const targetDir = env.CARGO_TARGET_DIR ? path.resolve(cwd, env.CARGO_TARGET_DIR) : null;
    return {
      env: targetDir ? { ...env, CARGO_TARGET_DIR: targetDir } : { ...env },
      targetDir,
      release() {},
    };
  }

  const worktreeRoot = canonicalPath(gitOutput(cwd, ['rev-parse', '--show-toplevel']).trim());
  const commonGitDirValue = gitOutput(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  const commonGitDir = canonicalPath(commonGitDirValue);
  const repositoryPath = path.join(
    defaultCacheRoot(env),
    CACHE_LAYOUT_VERSION,
    cacheKey(commonGitDir),
  );
  const entriesPath = path.join(repositoryPath, 'worktrees');
  const worktreeKey = cacheKey(worktreeRoot);
  const entryPath = path.join(entriesPath, worktreeKey);
  const leasesPath = path.join(entryPath, 'leases');
  const targetDir = path.join(entryPath, 'target');
  mkdirSync(leasesPath, { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  const leasePath = path.join(leasesPath, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(leasePath, `${JSON.stringify({ pid: process.pid })}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    path.join(entryPath, 'worktree.json'),
    `${JSON.stringify({ path: worktreeRoot, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const activeKeys = new Set(registeredWorktreeRoots(cwd).map(cacheKey));
  pruneRemovedWorktrees(entriesPath, activeKeys);

  let released = false;
  return {
    env: { ...env, CARGO_TARGET_DIR: targetDir },
    targetDir,
    release() {
      if (released) return;
      released = true;
      rmSync(leasePath, { force: true });
    },
  };
}
