import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '../..');
const script = path.join(rootDir, 'scripts/release-latest.mts');

test('release:latest dry run describes the complete release workflow', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, '--dry-run'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fast-forward to origin\/main/i);
  assert.match(result.stdout, /desktop:build:macos/);
  assert.match(result.stdout, /local iOS production EAS build/i);
  assert.match(result.stdout, /submit the generated IPA to TestFlight/i);
});
