const { randomUUID } = require('node:crypto');
const {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const defaultMobileRoot = path.resolve(__dirname, '..');
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const LOCK_OWNER_FILE = 'owner.json';
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_UNKNOWN_LOCK_STALE_MS = 30_000;

function resolveBundlePaths(mobileRoot = defaultMobileRoot) {
  const requireFromMobile = createRequire(path.join(mobileRoot, 'package.json'));
  const packageRoot = path.dirname(requireFromMobile.resolve('expo-widgets/package.json'));
  return {
    buildScript: path.join(packageRoot, 'scripts/build-bundle.mjs'),
    lockPath: path.join(packageRoot, 'bundle/.ExpoWidgets.bundle.lock'),
    outputPath: path.join(packageRoot, 'bundle/build/ExpoWidgets.bundle'),
  };
}

function isValidBundle(outputPath) {
  try {
    const stat = lstatSync(outputPath);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function lockIsRecoverable(lockPath, { now, processIsAlive, unknownLockStaleMs }) {
  const owner = readLockOwner(lockPath);
  if (owner && typeof owner.token === 'string' && Number.isSafeInteger(owner.pid)) {
    return !processIsAlive(owner.pid);
  }

  try {
    return now() - statSync(lockPath).mtimeMs >= unknownLockStaleMs;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function createOwnedLock(lockPath, now) {
  const token = randomUUID();
  mkdirSync(lockPath);
  try {
    writeFileSync(
      path.join(lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ createdAt: new Date(now()).toISOString(), pid: process.pid, token }),
      { flag: 'wx' },
    );
  } catch (error) {
    rmSync(lockPath, { force: true, recursive: true });
    throw error;
  }
  return token;
}

function quarantineLock(lockPath) {
  const quarantinePath = `${lockPath}.abandoned-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  rmSync(quarantinePath, { force: true, recursive: true });
  return true;
}

function tryAcquireRecoveryLock(recoveryPath, options) {
  try {
    return createOwnedLock(recoveryPath, options.now);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  if (!lockIsRecoverable(recoveryPath, options) || !quarantineLock(recoveryPath)) {
    return null;
  }

  try {
    return createOwnedLock(recoveryPath, options.now);
  } catch (error) {
    if (error && error.code === 'EEXIST') return null;
    throw error;
  }
}

function recoverAbandonedLock(lockPath, options) {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryToken = tryAcquireRecoveryLock(recoveryPath, options);
  if (!recoveryToken) return;

  try {
    if (!lockIsRecoverable(lockPath, options)) return;
    quarantineLock(lockPath);
  } finally {
    releaseBundleLock(recoveryPath, recoveryToken);
  }
}

function acquireBundleLock(
  lockPath,
  {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockPollMs = DEFAULT_LOCK_POLL_MS,
    now = Date.now,
    processIsAlive = isProcessAlive,
    sleep = (milliseconds) => Atomics.wait(lockWaitBuffer, 0, 0, milliseconds),
    unknownLockStaleMs = DEFAULT_UNKNOWN_LOCK_STALE_MS,
  } = {},
) {
  const deadline = now() + lockTimeoutMs;
  const recoveryOptions = { now, processIsAlive, unknownLockStaleMs };

  while (true) {
    try {
      return createOwnedLock(lockPath, now);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    recoverAbandonedLock(lockPath, recoveryOptions);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting ${lockTimeoutMs}ms for Expo Widgets bundle lock.`);
    }
    sleep(Math.min(lockPollMs, remainingMs));
  }
}

function releaseBundleLock(lockPath, token) {
  const owner = readLockOwner(lockPath);
  if (owner?.token === token && owner.pid === process.pid) {
    rmSync(lockPath, { force: true, recursive: true });
  }
}

function prepareExpoWidgetsBundle({
  checkOnly = false,
  mobileRoot = defaultMobileRoot,
  bundlePaths = resolveBundlePaths(mobileRoot),
  logger = console,
  run = spawnSync,
  lockOptions,
} = {}) {
  const token = acquireBundleLock(bundlePaths.lockPath, lockOptions);
  try {
    if (isValidBundle(bundlePaths.outputPath)) {
      logger.log('Expo Widgets runtime bundle is current.');
      return bundlePaths.outputPath;
    }

    if (checkOnly) {
      throw new Error(
        'Expo Widgets runtime bundle is missing or corrupt. Run: pnpm --filter @dappercode/mobile run widgets:prepare',
      );
    }

    const result = run(process.execPath, [bundlePaths.buildScript, mobileRoot], {
      cwd: mobileRoot,
      stdio: 'inherit',
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Expo Widgets bundle generation failed with exit code ${result.status}.`);
    }
    if (!isValidBundle(bundlePaths.outputPath)) {
      throw new Error(
        `Expo Widgets bundle generation did not create a regular, nonempty file at ${bundlePaths.outputPath}.`,
      );
    }

    logger.log('Prepared Expo Widgets runtime bundle.');
    return bundlePaths.outputPath;
  } finally {
    releaseBundleLock(bundlePaths.lockPath, token);
  }
}

if (require.main === module) {
  try {
    prepareExpoWidgetsBundle({ checkOnly: process.argv.includes('--check') });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  LOCK_OWNER_FILE,
  isValidBundle,
  prepareExpoWidgetsBundle,
  resolveBundlePaths,
};
