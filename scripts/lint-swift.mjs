import { execFileSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('Skipping SwiftLint on non-macOS platforms.');
  process.exit(0);
}

const rootDir = path.resolve(import.meta.dirname, '..');

try {
  execFileSync('swiftlint', ['--version'], { cwd: rootDir, stdio: 'ignore' });
} catch {
  throw new Error('SwiftLint is required on macOS. Install it with "brew install swiftlint".');
}

execFileSync(
  'swiftlint',
  [
    'lint',
    '--config',
    '.swiftlint.yml',
    '--strict',
    '--quiet',
    '--force-exclude',
    'apps/desktop/macos',
    'apps/mobile/modules',
  ],
  { cwd: rootDir, stdio: 'inherit' },
);
