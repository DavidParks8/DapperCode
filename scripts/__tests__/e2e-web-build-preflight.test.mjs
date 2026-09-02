import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/check-e2e-web-build-preflight.mjs');

function runChecker(repoRoot) {
  return spawnSync(process.execPath, [checker, repoRoot], { encoding: 'utf8' });
}

function withSyntheticRepo(globalSetupSource, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dappercode-e2e-preflight-'));
  try {
    mkdirSync(path.join(directory, 'e2e'), { recursive: true });
    writeFileSync(path.join(directory, 'e2e', 'globalSetup.ts'), globalSetupSource);
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the real e2e/globalSetup.ts pre-builds the Expo bundle before Playwright forks workers', () => {
  const result = runChecker(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /awaits ensureWebBuild\(\) before Playwright forks workers/);
});

test('rejects the original cold-build-race shape that only builds the bridge', () => {
  // This is the exact shape of e2e/globalSetup.ts before the fix for GitHub Actions job
  // 99960912845 (run 33539193818): no reference to ensureWebBuild at all, so the "site" worker
  // fixture built the Expo web bundle lazily and raced its own 60s fixture timeout.
  const result = withSyntheticRepo(
    `import { execFileSync } from 'node:child_process';
import { repoRoot } from './harness/paths.ts';

export default function globalSetup(): void {
  execFileSync('pnpm', ['run', 'cargo', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}
`,
    runChecker,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must import ensureWebBuild/);
});

test('rejects an import of ensureWebBuild that is never awaited in globalSetup', () => {
  // Importing the function without calling (and awaiting) it would silently reintroduce the race:
  // Playwright would still fork workers before the bundle is guaranteed to be on disk.
  const result = withSyntheticRepo(
    `import { ensureWebBuild } from './harness/webBuild.ts';

export default async function globalSetup(): Promise<void> {
  const build = ensureWebBuild;
  void build;
}
`,
    runChecker,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must .await ensureWebBuild\(\)./);
});

test('rejects a synchronous globalSetup that could not await the pre-build step', () => {
  const result = withSyntheticRepo(
    `import { ensureWebBuild } from './harness/webBuild.ts';

export default function globalSetup(): void {
  void ensureWebBuild();
}
`,
    runChecker,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must export an async default globalSetup function/);
});

test('rejects a real await call that lives in an unrelated function instead of globalSetup', () => {
  // A naive greedy text match (`{...}` to the end of the file) would find this `await
  // ensureWebBuild()` and pass, even though globalSetup() itself never calls it. This exact shape
  // is the concrete false-positive a prior version of the checker produced.
  const result = withSyntheticRepo(
    `import { ensureWebBuild } from './harness/webBuild.ts';

export default async function globalSetup(): Promise<void> {
  doTheRealSetupWithoutBuildingWeb();
}

async function unrelatedHelperNeverCalledByGlobalSetup() {
  await ensureWebBuild();
}
`,
    runChecker,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must .await ensureWebBuild\(\)./);
});

test('rejects a call that only appears inside a comment in globalSetup', () => {
  const result = withSyntheticRepo(
    `import { ensureWebBuild } from './harness/webBuild.ts';

export default async function globalSetup(): Promise<void> {
  // await ensureWebBuild();
  doTheRealSetup();
}
`,
    runChecker,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must .await ensureWebBuild\(\)./);
});

test('accepts additional unrelated setup statements alongside the awaited call', () => {
  const result = withSyntheticRepo(
    `import { ensureWebBuild } from './harness/webBuild.ts';

export default async function globalSetup(): Promise<void> {
  const message = 'this string mentions webBuild but is not the import';
  void message;
  doTheRealSetup();
  await ensureWebBuild();
}
`,
    runChecker,
  );
  assert.equal(result.status, 0, result.stderr);
});
