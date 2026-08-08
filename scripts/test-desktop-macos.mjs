#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'darwin') {
  console.log('Skipping macOS native shell tests on this platform.');
  process.exit(0);
}

const rootDir = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'dappercode-macos-tests-'));
const testExecutable = path.join(temporaryDirectory, 'AppTerminationTests');

try {
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-parse-as-library',
      'apps/desktop/macos/AppTermination.swift',
      'apps/desktop/macos/BridgeStatusObserver.swift',
      'apps/desktop/macos/tests/AppTerminationTests.swift',
      '-o',
      testExecutable,
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  execFileSync(testExecutable, { cwd: rootDir, stdio: 'inherit' });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
