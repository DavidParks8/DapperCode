import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const runner = path.join(root, 'scripts/run-cargo.mjs');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('managed Cargo targets are isolated and removed after their worktree is deleted', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'dappercode-cargo-target-test-'));
  const repository = path.join(temporaryDirectory, 'repository');
  const firstWorktree = path.join(temporaryDirectory, 'first');
  const secondWorktree = path.join(temporaryDirectory, 'second');
  const cacheRoot = path.join(temporaryDirectory, 'cache');
  const env = {
    ...process.env,
    CI: '',
    DAPPERCODE_MANAGED_CARGO_TARGETS: '1',
    DAPPERCODE_CARGO_TARGET_ROOT: cacheRoot,
  };

  try {
    mkdirSync(repository);
    run('git', ['init', '--quiet'], repository);
    run('git', ['config', 'user.email', 'test@example.com'], repository);
    run('git', ['config', 'user.name', 'DapperCode Test'], repository);
    writeFileSync(path.join(repository, 'README.md'), 'test\n');
    run('git', ['add', 'README.md'], repository);
    run('git', ['commit', '--quiet', '--no-gpg-sign', '-m', 'Initial commit'], repository);
    run('git', ['worktree', 'add', '--quiet', '-b', 'first', firstWorktree], repository);
    run('git', ['worktree', 'add', '--quiet', '-b', 'second', secondWorktree], repository);

    const firstTarget = run(process.execPath, [runner, '--print-target-dir'], firstWorktree, env);
    const secondTarget = run(process.execPath, [runner, '--print-target-dir'], secondWorktree, env);
    assert.notEqual(firstTarget, secondTarget);
    assert.ok(firstTarget.startsWith(cacheRoot));
    assert.ok(secondTarget.startsWith(cacheRoot));

    const firstArtifact = path.join(firstTarget, 'debug', 'large-artifact');
    mkdirSync(path.dirname(firstArtifact), { recursive: true });
    writeFileSync(firstArtifact, 'build output');
    rmSync(firstWorktree, { recursive: true, force: true });
    assert.ok(existsSync(firstArtifact));
    assert.match(run('git', ['worktree', 'list', '--porcelain'], repository), /prunable/);

    run(process.execPath, [runner, '--print-target-dir'], secondWorktree, env);
    assert.equal(existsSync(path.dirname(firstTarget)), false);
    assert.equal(existsSync(secondTarget), true);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('CI keeps Cargo target output in the checkout unless explicitly enabled', () => {
  const result = spawnSync(process.execPath, [runner, '--print-target-dir'], {
    cwd: root,
    env: {
      ...process.env,
      CI: 'true',
      DAPPERCODE_MANAGED_CARGO_TARGETS: '',
      CARGO_TARGET_DIR: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '\n');
});

test(
  'pruning does not remove a deleted worktree target while its Cargo command is active',
  { skip: process.platform === 'win32' },
  async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'dappercode-cargo-lease-test-'));
    const repository = path.join(temporaryDirectory, 'repository');
    const activeWorktree = path.join(temporaryDirectory, 'active');
    const pruningWorktree = path.join(temporaryDirectory, 'pruning');
    const cacheRoot = path.join(temporaryDirectory, 'cache');
    const binDirectory = path.join(temporaryDirectory, 'bin');
    const startedFile = path.join(temporaryDirectory, 'started');
    const releaseFile = path.join(temporaryDirectory, 'release');
    const fakeCargo = path.join(binDirectory, 'cargo');
    const env = {
      ...process.env,
      CI: '',
      DAPPERCODE_MANAGED_CARGO_TARGETS: '1',
      DAPPERCODE_CARGO_TARGET_ROOT: cacheRoot,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      STARTED_FILE: startedFile,
      RELEASE_FILE: releaseFile,
    };
    let child;

    try {
      mkdirSync(repository);
      mkdirSync(binDirectory);
      run('git', ['init', '--quiet'], repository);
      run('git', ['config', 'user.email', 'test@example.com'], repository);
      run('git', ['config', 'user.name', 'DapperCode Test'], repository);
      writeFileSync(path.join(repository, 'README.md'), 'test\n');
      run('git', ['add', 'README.md'], repository);
      run('git', ['commit', '--quiet', '--no-gpg-sign', '-m', 'Initial commit'], repository);
      run('git', ['worktree', 'add', '--quiet', '-b', 'active', activeWorktree], repository);
      run('git', ['worktree', 'add', '--quiet', '-b', 'pruning', pruningWorktree], repository);
      writeFileSync(
        fakeCargo,
        `#!/bin/sh
set -eu
mkdir -p "$CARGO_TARGET_DIR/debug"
printf artifact > "$CARGO_TARGET_DIR/debug/active-artifact"
printf started > "$STARTED_FILE"
while [ ! -e "$RELEASE_FILE" ]; do sleep 0.05; done
`,
      );
      chmodSync(fakeCargo, 0o755);

      const activeTarget = run(
        process.execPath,
        [runner, '--print-target-dir'],
        activeWorktree,
        env,
      );
      child = spawn(process.execPath, [runner, 'build'], {
        cwd: activeWorktree,
        env,
        stdio: 'pipe',
      });
      const startedDeadline = Date.now() + 5_000;
      while (!existsSync(startedFile)) {
        assert.equal(child.exitCode, null, 'managed Cargo command exited before starting');
        assert.ok(Date.now() < startedDeadline, 'timed out waiting for managed Cargo command');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      rmSync(activeWorktree, { recursive: true, force: true });
      run(process.execPath, [runner, '--print-target-dir'], pruningWorktree, env);
      assert.equal(existsSync(path.join(activeTarget, 'debug', 'active-artifact')), true);

      writeFileSync(releaseFile, 'release\n');
      const exitCode = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(exitCode, 0);
      run(process.execPath, [runner, '--print-target-dir'], pruningWorktree, env);
      assert.equal(existsSync(path.dirname(activeTarget)), false);
    } finally {
      if (child?.exitCode === null) {
        writeFileSync(releaseFile, 'release\n');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
);
