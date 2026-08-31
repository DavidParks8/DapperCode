import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { repoRoot } from './harness/paths.ts';

/**
 * Builds the production bridge and the typed ACP fixture once before Playwright forks workers.
 * Individual tests copy both executables into their isolated runtime roots before launching them.
 */
export default function globalSetup(): void {
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
}
