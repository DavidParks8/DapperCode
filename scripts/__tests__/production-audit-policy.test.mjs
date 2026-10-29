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

test('production audit accepts a tree without high or critical advisories', () => {
  const result = runChecker({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no high or critical advisories/);
});

test('production audit rejects all high and critical advisories, including former exceptions', () => {
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
  assert.match(unexpected.stderr, /dangerous#9999999/);

  const formerExceptions = runChecker(reviewed);
  assert.notEqual(formerExceptions.status, 0);
  assert.match(formerExceptions.stderr, /image-size#1138808@1\.2\.1/);
  assert.match(formerExceptions.stderr, /image-size#1138809@1\.2\.1/);

  const changed = runChecker({
    ...reviewed,
    1138808: {
      ...reviewed[1138808],
      findings: [{ version: '2.0.2' }],
    },
  });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /image-size#1138808@2\.0\.2/);

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
