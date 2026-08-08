import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const reviewedAdvisories = new Map([
  // npm 10 omits these transitive production advisories while npm 11 reports them. Permit absence
  // only for the exact reviewed lockfile version; any dependency change requires a fresh review.
  [1121797, { name: 'linkify-it', optionalThroughLockedVersion: '5.0.1' }],
  [1124012, { name: 'linkify-it', optionalThroughLockedVersion: '5.0.1' }],
  // image-size is pulled through Metro build tooling and is absent from the native app bundle.
  // npm offers only a breaking Expo change, so there is no compatible production-runtime fix.
  [1138808, { name: 'image-size' }],
  [1138809, { name: 'image-size' }],
]);

// npm reports `fixAvailable` as `true` when a compatible release exists, or as the package a
// breaking upgrade would land on. A breaking upgrade of an unrelated framework dependency is not
// an actionable fix for a reviewed advisory, so only compatible fixes fail the gate.
const hasCompatibleFix = (fixAvailable) => {
  if (fixAvailable === false) return false;
  if (typeof fixAvailable === 'object' && fixAvailable !== null) {
    return fixAvailable.isSemVerMajor !== true;
  }
  return true;
};

const lockedVersions = (name) => {
  const suffix = `/node_modules/${name}`;
  const versions = Object.entries(lockfile.packages ?? {})
    .filter(
      ([packagePath]) => packagePath === `node_modules/${name}` || packagePath.endsWith(suffix),
    )
    .map(([, entry]) => entry?.version)
    .filter(Boolean);
  const legacyVersion = lockfile.dependencies?.[name]?.version;
  if (legacyVersion) versions.push(legacyVersion);
  try {
    const installed = JSON.parse(
      readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    ).version;
    if (installed) versions.push(installed);
  } catch {
    // A clean CI install always has production packages; lockfile-only callers use entries above.
  }
  return versions;
};

const versionAtMost = (version, maximum) => {
  const parse = (value) => value.split('.').map((part) => Number.parseInt(part, 10));
  const current = parse(version);
  const limit = parse(maximum);
  if ([...current, ...limit].some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < Math.max(current.length, limit.length); index += 1) {
    const currentPart = current[index] ?? 0;
    const limitPart = limit[index] ?? 0;
    if (currentPart < limitPart) return true;
    if (currentPart > limitPart) return false;
  }
  return true;
};

const loadReport = () => {
  if (process.argv[2]) {
    return JSON.parse(readFileSync(path.resolve(root, process.argv[2]), 'utf8'));
  }

  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!result.stdout.trim()) {
    throw new Error(`npm audit produced no JSON: ${result.stderr.trim() || 'unknown error'}`);
  }
  return JSON.parse(result.stdout);
};

const report = loadReport();
const vulnerabilities = report.vulnerabilities ?? {};
const found = new Map();
const critical = [];

for (const vulnerability of Object.values(vulnerabilities)) {
  for (const advisory of Array.isArray(vulnerability.via) ? vulnerability.via : []) {
    if (!advisory || typeof advisory !== 'object') continue;
    if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
    found.set(advisory.source, advisory.name);
    if (advisory.severity === 'critical') {
      critical.push([advisory.source, advisory.name]);
    }
  }
}

const unexpected = [...found].filter(([id, name]) => reviewedAdvisories.get(id)?.name !== name);
const stale = [...reviewedAdvisories].filter(([id, review]) => {
  if (found.get(id) === review.name) return false;
  return !lockedVersions(review.name).some(
    (version) =>
      review.optionalThroughLockedVersion &&
      versionAtMost(version, review.optionalThroughLockedVersion),
  );
});
const fixable = [...new Set(found.values())].filter((name) =>
  hasCompatibleFix(vulnerabilities[name]?.fixAvailable),
);

if (critical.length > 0 || unexpected.length > 0 || stale.length > 0 || fixable.length > 0) {
  const details = [
    critical.length > 0
      ? `critical: ${critical.map(([id, name]) => `${name}#${id}`).join(', ')}`
      : null,
    unexpected.length > 0
      ? `unexpected: ${unexpected.map(([id, name]) => `${name}#${id}`).join(', ')}`
      : null,
    stale.length > 0
      ? `stale exceptions: ${stale.map(([id, review]) => `${review.name}#${id}`).join(', ')}`
      : null,
    fixable.length > 0 ? `fix now available: ${fixable.join(', ')}` : null,
  ].filter(Boolean);
  throw new Error(`Production dependency audit requires review (${details.join('; ')})`);
}

const advisoryLabel = found.size === 1 ? 'advisory' : 'advisories';
process.stdout.write(
  `Production dependency audit passed with ${found.size} reviewed high-severity ${advisoryLabel} and no critical advisories.\n`,
);
