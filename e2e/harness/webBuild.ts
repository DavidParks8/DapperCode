import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { repoRoot } from './paths.ts';

/**
 * Metro inlines `EXPO_PUBLIC_*` values at build time, so the e2e bundle is a distinct artifact from
 * a normal web build. Query-token auth is what lets the browser WebSocket authenticate against the
 * harness bridge, because browsers cannot set request headers on a WebSocket handshake.
 */
const E2E_BUILD_ENV: Readonly<Record<string, string>> = {
  EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH: 'true',
  EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE: 'true',
};

const BUILD_ROOT = path.join(repoRoot, '.e2e', 'web-build');
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 500;

export interface WebBuild {
  /** Directory containing `index.html` and the hashed `_expo` bundle output. */
  readonly dir: string;
  /** Stable fingerprint of the inputs that produced this build. */
  readonly fingerprint: string;
  readonly reused: boolean;
}

/**
 * Builds the Expo web bundle once per unique input fingerprint and reuses it afterwards.
 *
 * Concurrent test runs are expected. Builds are keyed by fingerprint so different sources never
 * share a directory, a directory-creation lock keeps two runs from building the same fingerprint
 * twice, and the finished build is moved into place with a single atomic rename so a reader never
 * observes a half-written bundle.
 */
export async function ensureWebBuild(options: { forceRebuild?: boolean } = {}): Promise<WebBuild> {
  const fingerprint = await computeFingerprint();
  const dir = path.join(BUILD_ROOT, fingerprint);

  if (!options.forceRebuild && (await isCompleteBuild(dir))) {
    return { dir, fingerprint, reused: true };
  }

  const lockDir = `${dir}.lock`;
  const acquired = await acquireLock(lockDir);
  if (!acquired) {
    await waitForBuild(dir, lockDir);
    return { dir, fingerprint, reused: true };
  }

  try {
    // Re-checked under the lock. A forced rebuild deliberately ignores the existing build, but it
    // still has to hold the lock first: deleting the shared directory before acquiring it would
    // pull the bundle out from under a concurrent run that is already serving it.
    if (!options.forceRebuild && (await isCompleteBuild(dir))) {
      return { dir, fingerprint, reused: true };
    }
    await buildInto(dir);
    return { dir, fingerprint, reused: false };
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function buildInto(destination: string): Promise<void> {
  await mkdir(BUILD_ROOT, { recursive: true });
  // Staged beside the destination rather than under the OS temp dir: rename() is only atomic
  // within a filesystem, and on CI the temp dir is frequently a different mount, which would fail
  // the publish with EXDEV.
  const staging = await mkdtemp(`${destination}.staging-`);
  const output = path.join(staging, 'web');

  try {
    await runExpoExport(output);
    if (!existsSync(path.join(output, 'index.html'))) {
      throw new Error(`Expo web export did not produce an index.html in ${output}`);
    }
    // The completion marker is written inside staging so it lands in the same atomic rename.
    // Writing it after the rename leaves a window where the directory is visible but unmarked, and
    // a parallel run could adopt it as incomplete and rebuild over the top.
    await writeFile(path.join(output, '.e2e-build-complete'), new Date().toISOString(), 'utf8');
    await rm(destination, { recursive: true, force: true });
    await rename(output, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function runExpoExport(outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'expo', 'export', '--platform', 'web', '--output-dir', outputDir, '--clear'],
      {
        cwd: path.join(repoRoot, 'apps', 'mobile'),
        env: { ...process.env, ...E2E_BUILD_ENV, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`expo export failed with exit code ${String(code)}\n${output}`));
    });
  });
}

async function isCompleteBuild(dir: string): Promise<boolean> {
  return (
    existsSync(path.join(dir, '.e2e-build-complete')) && existsSync(path.join(dir, 'index.html'))
  );
}

async function acquireLock(lockDir: string): Promise<boolean> {
  await mkdir(BUILD_ROOT, { recursive: true });
  try {
    await mkdir(lockDir);
    return true;
  } catch {
    await discardStaleLock(lockDir);
    return false;
  }
}

async function discardStaleLock(lockDir: string): Promise<void> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // The lock disappeared on its own, which is the outcome we wanted anyway.
  }
}

async function waitForBuild(dir: string, lockDir: string): Promise<void> {
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    if (await isCompleteBuild(dir)) {
      return;
    }
    if (!existsSync(lockDir)) {
      // The builder died without publishing a build, so take over the work.
      const acquired = await acquireLock(lockDir);
      if (acquired) {
        try {
          if (!(await isCompleteBuild(dir))) {
            await buildInto(dir);
          }
          return;
        } finally {
          await rm(lockDir, { recursive: true, force: true });
        }
      }
    }
    await delay(LOCK_POLL_MS);
  }
  throw new Error(`Timed out waiting for a concurrent e2e web build at ${dir}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function computeFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(E2E_BUILD_ENV));

  // The bundle depends on the resolved dependency tree and the toolchain that builds it, not just
  // on app source. Without these, switching branches or Node versions can silently reuse a stale
  // bundle that happens to share a source hash.
  hash.update(process.version);

  const mobileRoot = path.join(repoRoot, 'apps', 'mobile');
  const files = [
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'pnpm-lock.yaml'),
    path.join(mobileRoot, 'package.json'),
    path.join(mobileRoot, 'app.json'),
    path.join(mobileRoot, 'babel.config.js'),
    path.join(mobileRoot, 'metro.config.js'),
    path.join(mobileRoot, 'tsconfig.json'),
  ];
  for (const file of files) {
    hash.update(file);
    hash.update(await readFileIfPresent(file));
  }

  for (const directory of ['src', 'assets']) {
    for (const file of await collectSourceFiles(path.join(mobileRoot, directory))) {
      hash.update(path.relative(mobileRoot, file));
      hash.update(await readFile(file));
    }
  }

  return hash.digest('hex').slice(0, 16);
}

async function readFileIfPresent(file: string): Promise<Buffer | string> {
  try {
    return await readFile(file);
  } catch {
    return '';
  }
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // An optional directory such as `assets` may not exist in every checkout.
    return [];
  }
  const collected = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return collectSourceFiles(entryPath);
        }
        return entry.isFile() ? [entryPath] : [];
      }),
  );
  return collected.flat().sort();
}
