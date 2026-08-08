import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewedAdvisories = new Map([
  // npm reports both IDs for the same scanner; MarkdownIt's linkify option stays disabled here.
  [1121797, 'linkify-it'],
  [1124012, 'linkify-it'],
  // image-size is pulled through Metro build tooling and is absent from the native app bundle.
  // npm offers only a breaking Expo change, so there is no compatible production-runtime fix.
  [1138808, 'image-size'],
  [1138809, 'image-size'],
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

const unexpected = [...found].filter(([id, name]) => reviewedAdvisories.get(id) !== name);
const stale = [...reviewedAdvisories].filter(([id, name]) => found.get(id) !== name);
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
      ? `stale exceptions: ${stale.map(([id, name]) => `${name}#${id}`).join(', ')}`
      : null,
    fixable.length > 0 ? `fix now available: ${fixable.join(', ')}` : null,
  ].filter(Boolean);
  throw new Error(`Production dependency audit requires review (${details.join('; ')})`);
}

const advisoryLabel = found.size === 1 ? 'advisory' : 'advisories';
process.stdout.write(
  `Production dependency audit passed with ${found.size} reviewed high-severity ${advisoryLabel} and no critical advisories.\n`,
);
