#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const traySource = readFileSync(
  path.join(rootDir, 'apps/desktop/macos/DapperCodeApp.swift'),
  'utf8',
);

try {
  if (
    traySource.includes('Text(model.snapshot.headline)') ||
    traySource.includes("Broker follows DapperCode's lifetime")
  ) {
    throw new Error('macOS tray menu contains a removed bridge status message.');
  }

  if (
    !/Button\("About DapperCode"\)\s*\{\s*AboutPanelPresenter\.present\(\)\s*\}/.test(traySource)
  ) {
    throw new Error('macOS tray menu does not invoke the tested About panel action.');
  }

  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-parse-as-library',
      'apps/desktop/macos/AboutPanelPresenter.swift',
      'apps/desktop/macos/AppTermination.swift',
      'apps/desktop/macos/BridgeStatusObserver.swift',
      'apps/desktop/macos/tests/AppTerminationTests.swift',
      '-o',
      testExecutable,
      '-framework',
      'AppKit',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  execFileSync(testExecutable, { cwd: rootDir, stdio: 'inherit' });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
