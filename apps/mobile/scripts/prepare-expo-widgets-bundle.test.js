const { spawn } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const {
  LOCK_OWNER_FILE,
  isValidBundle,
  prepareExpoWidgetsBundle,
  resolveBundlePaths,
} = require('./prepare-expo-widgets-bundle.cjs');
const mobilePackage = require('../package.json');
const workspacePackage = require('../../../package.json');

const scratchRoots = [];

function createScratchBundle() {
  const root = mkdtempSync(path.join(__dirname, '.expo-widgets-test-'));
  scratchRoots.push(root);
  const bundlePaths = {
    buildScript: path.join(root, 'build-bundle.mjs'),
    lockPath: path.join(root, 'bundle/.ExpoWidgets.bundle.lock'),
    outputPath: path.join(root, 'bundle/build/ExpoWidgets.bundle'),
  };
  mkdirSync(path.dirname(bundlePaths.lockPath), { recursive: true });
  return { bundlePaths, root };
}

function writeBundle(outputPath, contents = 'globalThis.__expoWidgetRender = () => ({});') {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
}

function spawnPrepareWorker(modulePath, root, bundlePaths) {
  const source = `
    const { prepareExpoWidgetsBundle } = require(process.argv[1]);
    const path = require('node:path');
    const root = process.argv[2];
    prepareExpoWidgetsBundle({
      mobileRoot: root,
      bundlePaths: {
        buildScript: path.join(root, 'build-bundle.mjs'),
        lockPath: path.join(root, 'bundle/.ExpoWidgets.bundle.lock'),
        outputPath: path.join(root, 'bundle/build/ExpoWidgets.bundle'),
      },
    });
  `;
  const child = spawn(process.execPath, ['-e', source, modulePath, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    completion: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal, stderr, stdout }));
    }),
    outputPath: bundlePaths.outputPath,
  };
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop(), { force: true, recursive: true });
  }
});

describe('Expo Widgets runtime bundle setup', () => {
  it('wires install and coverage to prepare generated mobile assets', () => {
    expect(workspacePackage.scripts.postinstall).toContain('run generated:prepare');
    expect(mobilePackage.scripts['pretest:coverage']).toBe('pnpm run generated:prepare');
    expect(mobilePackage.scripts['generated:prepare']).toContain('pnpm run widgets:prepare');
  });

  it('resolves the bundle, lock, and upstream generator from the installed package', () => {
    const resolved = resolveBundlePaths();
    const packageRoot = path.dirname(require.resolve('expo-widgets/package.json'));

    expect(resolved).toEqual({
      buildScript: path.join(packageRoot, 'scripts/build-bundle.mjs'),
      lockPath: path.join(packageRoot, 'bundle/.ExpoWidgets.bundle.lock'),
      outputPath: path.join(packageRoot, 'bundle/build/ExpoWidgets.bundle'),
    });
  });

  it('accepts only regular, nonempty bundle files', () => {
    const { bundlePaths } = createScratchBundle();

    expect(isValidBundle(bundlePaths.outputPath)).toBe(false);
    writeBundle(bundlePaths.outputPath, '');
    expect(isValidBundle(bundlePaths.outputPath)).toBe(false);
    rmSync(bundlePaths.outputPath);
    mkdirSync(bundlePaths.outputPath);
    expect(isValidBundle(bundlePaths.outputPath)).toBe(false);
    rmSync(bundlePaths.outputPath, { recursive: true });
    writeBundle(bundlePaths.outputPath);
    expect(isValidBundle(bundlePaths.outputPath)).toBe(true);
  });

  it('does not rebuild an existing valid bundle', () => {
    const { bundlePaths } = createScratchBundle();
    const run = jest.fn();
    writeBundle(bundlePaths.outputPath);

    expect(prepareExpoWidgetsBundle({ bundlePaths, logger: { log: jest.fn() }, run })).toBe(
      bundlePaths.outputPath,
    );
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(bundlePaths.lockPath)).toBe(false);
  });

  it('uses the installed offline generator when the published bundle is missing', () => {
    const { bundlePaths, root } = createScratchBundle();
    const run = jest.fn(() => {
      writeBundle(bundlePaths.outputPath);
      return { status: 0 };
    });

    expect(
      prepareExpoWidgetsBundle({
        bundlePaths,
        logger: { log: jest.fn() },
        mobileRoot: root,
        run,
      }),
    ).toBe(bundlePaths.outputPath);
    expect(run).toHaveBeenCalledWith(process.execPath, [bundlePaths.buildScript, root], {
      cwd: root,
      stdio: 'inherit',
    });
  });

  it.each([
    ['zero-byte file', () => {}],
    ['directory', (outputPath) => mkdirSync(outputPath, { recursive: true })],
  ])('replaces a corrupt %s', (_description, createCorruptOutput) => {
    const { bundlePaths } = createScratchBundle();
    mkdirSync(path.dirname(bundlePaths.outputPath), { recursive: true });
    createCorruptOutput(bundlePaths.outputPath);
    if (!existsSync(bundlePaths.outputPath)) writeFileSync(bundlePaths.outputPath, '');
    const run = jest.fn(() => {
      rmSync(bundlePaths.outputPath, { force: true, recursive: true });
      writeBundle(bundlePaths.outputPath);
      return { status: 0 };
    });

    prepareExpoWidgetsBundle({ bundlePaths, logger: { log: jest.fn() }, run });

    expect(run).toHaveBeenCalledTimes(1);
    expect(isValidBundle(bundlePaths.outputPath)).toBe(true);
  });

  it('fails checks for corrupt output without rebuilding it', () => {
    const { bundlePaths } = createScratchBundle();
    writeBundle(bundlePaths.outputPath, '');
    const run = jest.fn();

    expect(() =>
      prepareExpoWidgetsBundle({
        bundlePaths,
        checkOnly: true,
        logger: { log: jest.fn() },
        run,
      }),
    ).toThrow('missing or corrupt');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a generator that exits without a valid bundle', () => {
    const { bundlePaths } = createScratchBundle();

    expect(() =>
      prepareExpoWidgetsBundle({
        bundlePaths,
        logger: { log: jest.fn() },
        run: () => ({ status: 0 }),
      }),
    ).toThrow('regular, nonempty file');
    expect(existsSync(bundlePaths.lockPath)).toBe(false);
  });

  it('recovers a lock whose owner process is gone', () => {
    const { bundlePaths } = createScratchBundle();
    mkdirSync(bundlePaths.lockPath);
    writeFileSync(
      path.join(bundlePaths.lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: 123, token: 'abandoned' }),
    );
    const run = jest.fn(() => {
      writeBundle(bundlePaths.outputPath);
      return { status: 0 };
    });

    prepareExpoWidgetsBundle({
      bundlePaths,
      lockOptions: { processIsAlive: () => false },
      logger: { log: jest.fn() },
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(bundlePaths.lockPath)).toBe(false);
  });

  it('recovers an orphaned recovery lock before reclaiming the bundle lock', () => {
    const { bundlePaths } = createScratchBundle();
    const recoveryPath = `${bundlePaths.lockPath}.recovery`;
    const sentinelPath = path.join(path.dirname(bundlePaths.lockPath), 'keep-me');
    for (const [lockPath, token] of [
      [bundlePaths.lockPath, 'abandoned-build'],
      [recoveryPath, 'abandoned-recovery'],
    ]) {
      mkdirSync(lockPath);
      writeFileSync(
        path.join(lockPath, LOCK_OWNER_FILE),
        JSON.stringify({ createdAt: new Date().toISOString(), pid: 123, token }),
      );
    }
    writeFileSync(sentinelPath, 'sentinel');
    const run = jest.fn(() => {
      writeBundle(bundlePaths.outputPath);
      return { status: 0 };
    });

    prepareExpoWidgetsBundle({
      bundlePaths,
      lockOptions: { processIsAlive: () => false },
      logger: { log: jest.fn() },
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(bundlePaths.lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('sentinel');
  });

  it('recovers a stale recovery lock with malformed owner metadata', () => {
    const { bundlePaths } = createScratchBundle();
    const recoveryPath = `${bundlePaths.lockPath}.recovery`;
    mkdirSync(bundlePaths.lockPath);
    writeFileSync(
      path.join(bundlePaths.lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: 123, token: 'abandoned' }),
    );
    mkdirSync(recoveryPath);
    writeFileSync(path.join(recoveryPath, LOCK_OWNER_FILE), '{not-json');
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(recoveryPath, staleTime, staleTime);
    const run = jest.fn(() => {
      writeBundle(bundlePaths.outputPath);
      return { status: 0 };
    });

    prepareExpoWidgetsBundle({
      bundlePaths,
      lockOptions: { processIsAlive: () => false, unknownLockStaleMs: 30_000 },
      logger: { log: jest.fn() },
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it('bounds waiting for a live lock', () => {
    const { bundlePaths } = createScratchBundle();
    mkdirSync(bundlePaths.lockPath);
    writeFileSync(
      path.join(bundlePaths.lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid, token: 'live' }),
    );

    expect(() =>
      prepareExpoWidgetsBundle({
        bundlePaths,
        lockOptions: { lockPollMs: 5, lockTimeoutMs: 20 },
        logger: { log: jest.fn() },
      }),
    ).toThrow('Timed out waiting 20ms');
  });

  it('serializes concurrent generators and rechecks output under the lock', async () => {
    const { bundlePaths, root } = createScratchBundle();
    const startedPath = path.join(root, 'build-started');
    const buildCountPath = path.join(root, 'build-count');
    writeFileSync(
      bundlePaths.buildScript,
      `
        import fs from 'node:fs';
        import path from 'node:path';
        const root = process.argv[2];
        fs.appendFileSync(path.join(root, 'build-count'), 'build\\n');
        fs.writeFileSync(path.join(root, 'build-started'), 'yes');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        const output = path.join(root, 'bundle/build/ExpoWidgets.bundle');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'globalThis.__expoWidgetRender = () => ({});');
      `,
    );
    const modulePath = path.join(__dirname, 'prepare-expo-widgets-bundle.cjs');

    const first = spawnPrepareWorker(modulePath, root, bundlePaths);
    await waitForFile(startedPath);
    const second = spawnPrepareWorker(modulePath, root, bundlePaths);
    const results = await Promise.all([first.completion, second.completion]);

    expect(results).toEqual([
      expect.objectContaining({ code: 0, signal: null, stderr: '' }),
      expect.objectContaining({ code: 0, signal: null, stderr: '' }),
    ]);
    expect(readFileSync(buildCountPath, 'utf8')).toBe('build\n');
    expect(isValidBundle(first.outputPath)).toBe(true);
    expect(existsSync(bundlePaths.lockPath)).toBe(false);
  });
});
