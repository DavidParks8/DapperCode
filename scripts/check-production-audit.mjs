import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewedAdvisories = new Map([
  // image-size is pulled through Metro build tooling and is absent from the native app bundle.
  // The patched major is outside Expo's compatible dependency range.
  [1138808, { name: 'image-size', versions: new Set(['1.2.1']) }],
  [1138809, { name: 'image-size', versions: new Set(['1.2.1']) }],
]);

const loadReport = () => {
  if (process.argv[2]) {
    return JSON.parse(readFileSync(path.resolve(root, process.argv[2]), 'utf8'));
  }

  const result = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!result.stdout.trim()) {
    throw new Error(`pnpm audit produced no JSON: ${result.stderr.trim() || 'unknown error'}`);
  }
  return JSON.parse(result.stdout);
};

const report = loadReport();
const advisories = report.advisories;
if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories)) {
  throw new Error('pnpm audit report is missing its advisories object');
}

const found = new Map();
const critical = [];

for (const advisory of Object.values(advisories)) {
  if (!advisory || typeof advisory !== 'object') continue;
  if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;

  const id = Number(advisory.id);
  const name = advisory.module_name;
  const versions = [
    ...new Set(
      (Array.isArray(advisory.findings) ? advisory.findings : [])
        .map((finding) => finding?.version)
        .filter((version) => typeof version === 'string' && version.length > 0),
    ),
  ].sort();
  if (!Number.isSafeInteger(id) || typeof name !== 'string' || name.length === 0) {
    throw new Error('pnpm audit returned a malformed high-severity advisory');
  }

  found.set(id, { name, versions });
  if (advisory.severity === 'critical') {
    critical.push([id, { name, versions }]);
  }
}

const unexpected = [...found].filter(([id, finding]) => {
  const review = reviewedAdvisories.get(id);
  return (
    review?.name !== finding.name ||
    finding.versions.length === 0 ||
    finding.versions.some((version) => !review.versions.has(version))
  );
});
const stale = [...reviewedAdvisories].filter(([id, review]) => {
  const finding = found.get(id);
  return (
    finding?.name !== review.name ||
    finding.versions.length === 0 ||
    finding.versions.some((version) => !review.versions.has(version))
  );
});

const formatFinding = ([id, finding]) =>
  `${finding.name}#${id}${finding.versions.length > 0 ? `@${finding.versions.join(',')}` : ''}`;

if (critical.length > 0 || unexpected.length > 0 || stale.length > 0) {
  const details = [
    critical.length > 0 ? `critical: ${critical.map(formatFinding).join(', ')}` : null,
    unexpected.length > 0 ? `unexpected: ${unexpected.map(formatFinding).join(', ')}` : null,
    stale.length > 0
      ? `stale exceptions: ${stale.map(([id, review]) => `${review.name}#${id}`).join(', ')}`
      : null,
  ].filter(Boolean);
  throw new Error(`Production dependency audit requires review (${details.join('; ')})`);
}

const advisoryLabel = found.size === 1 ? 'advisory' : 'advisories';
process.stdout.write(
  `Production dependency audit passed with ${found.size} reviewed high-severity ${advisoryLabel} and no critical advisories.\n`,
);
