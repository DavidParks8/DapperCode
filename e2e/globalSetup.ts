import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { repoRoot } from './harness/paths.ts';
import { ensureWebBuild } from './harness/webBuild.ts';

/**
 * Builds the production bridge, the typed ACP fixture, and the Expo web bundle once before
 * Playwright forks workers. Individual tests copy the bridge executables into their isolated
 * runtime roots before launching them.
 *
 * The web bundle used to build lazily, inside the per-worker "site" fixture, on whichever test
 * first requested it. That raced the fixture's own per-test timeout against however long a cold
 * `expo export` happened to take under CI load: every worker whose 60s window did not overlap the
 * moment the shared build finished failed with `Fixture "site" timeout ... exceeded during setup`,
 * even though the build itself was progressing fine in the background. Building it here, before
 * any worker exists, removes the race outright — by the time a worker requests "site", the build
 * is already complete on disk, so the fixture only has to start a static file server.
 */
export default async function globalSetup(): Promise<void> {
  execFileSync(
    'pnpm',
    [
      'run',
      'cargo',
      'build',
      '--locked',
      '--manifest-path',
      'services/rust-bridge/Cargo.toml',
      '--features',
      'e2e-agent',
      '--bin',
      'dappercode-bridge',
      '--bin',
      'dappercode-e2e-agent',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  const reportedTargetDir = execFileSync('node', ['scripts/run-cargo.mjs', '--print-target-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  // Managed target directories are intentionally disabled in CI, where Cargo falls back to the
  // manifest-local target directory. Locally the wrapper reports its worktree-scoped cache.
  const targetDir = reportedTargetDir || path.join(repoRoot, 'services', 'rust-bridge', 'target');
  process.env['DAPPERCODE_E2E_CARGO_TARGET_DIR'] = path.resolve(targetDir);

  await ensureWebBuild();
}
