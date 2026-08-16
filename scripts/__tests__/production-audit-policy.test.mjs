import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/check-production-audit.mjs');

function runChecker(advisories) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dappercode-production-audit-'));
  const reportPath = path.join(directory, 'audit.json');
  writeFileSync(reportPath, JSON.stringify({ advisories }));
  const result = spawnSync(process.execPath, [checker, reportPath], {
    cwd: root,
    encoding: 'utf8',
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

const reviewed = {
  1138808: {
    id: 1138808,
    module_name: 'image-size',
    severity: 'high',
    findings: [{ version: '1.2.1' }],
  },
  1138809: {
    id: 1138809,
    module_name: 'image-size',
    severity: 'high',
    findings: [{ version: '1.2.1' }],
  },
};

test('production audit accepts only the reviewed high-severity advisories', () => {
  const result = runChecker(reviewed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 reviewed high-severity advisories/);
});

test('production audit rejects new, stale, or changed advisories', () => {
  const unexpected = runChecker({
    ...reviewed,
    9999999: {
      id: 9999999,
      module_name: 'dangerous',
      severity: 'critical',
      findings: [{ version: '9.9.9' }],
    },
  });
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stderr, /unexpected: dangerous#9999999/);

  const stale = runChecker({});
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale exceptions: image-size#1138808, image-size#1138809/);

  const changed = runChecker({
    ...reviewed,
    1138808: {
      ...reviewed[1138808],
      findings: [{ version: '2.0.2' }],
    },
  });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /unexpected: image-size#1138808@2\.0\.2/);

  const escalated = runChecker({
    ...reviewed,
    1138808: {
      ...reviewed[1138808],
      severity: 'critical',
    },
  });
  assert.notEqual(escalated.status, 0);
  assert.match(escalated.stderr, /critical: image-size#1138808@1\.2\.1/);
});
