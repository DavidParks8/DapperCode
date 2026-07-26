import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_REPORTS = [
  'bridge=services/rust-bridge/target/llvm-cov/coverage.json',
  'desktop=apps/desktop/target/llvm-cov/coverage.json',
];

const DEFAULT_MINIMUM = Number(process.env.MIN_RUST_BRANCH_COVERAGE ?? '85');

const MINIMUMS = {
  bridge: Number(process.env.MIN_RUST_BRANCH_COVERAGE ?? '86'),
  desktop: Number(process.env.MIN_DESKTOP_BRANCH_COVERAGE ?? '85'),
};

/** Parses a `name=path` argument, tolerating a bare path for backwards compatibility. */
function parseReportArgument(argument, index) {
  const separator = argument.indexOf('=');
  if (separator < 0) {
    return { name: index === 0 ? 'bridge' : `report-${String(index)}`, reportPath: argument };
  }
  return {
    name: argument.slice(0, separator),
    reportPath: argument.slice(separator + 1),
  };
}

function branchTotals(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const totals = report.data?.[0]?.totals?.branches;

  if (!totals || !Number.isFinite(totals.count) || !Number.isFinite(totals.covered)) {
    throw new Error(`Rust coverage report has no branch totals: ${reportPath}`);
  }
  if (totals.count <= 0) {
    throw new Error(`Rust coverage report contains no instrumented branches: ${reportPath}`);
  }
  return totals;
}

const requested = process.argv.slice(2);
const reports = (requested.length > 0 ? requested : DEFAULT_REPORTS).map(parseReportArgument);

let failed = false;
for (const { name, reportPath } of reports) {
  const totals = branchTotals(path.resolve(root, reportPath));
  const minimum = MINIMUMS[name] ?? DEFAULT_MINIMUM;
  const percentage = (totals.covered * 100) / totals.count;

  process.stdout.write(
    `${name} branch coverage: ${percentage.toFixed(2)}% (${String(totals.covered)}/${String(totals.count)}), required ${minimum.toFixed(2)}%\n`,
  );
  if (percentage + Number.EPSILON < minimum) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
