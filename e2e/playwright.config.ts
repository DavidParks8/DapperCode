import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

import { repoRoot } from './harness/paths.ts';

/**
 * Every run writes to its own artifact directory. Playwright's default `test-results` is a fixed
 * path, which two simultaneous runs would clobber; deriving the directory from a run id keeps
 * parallel runs of this suite fully independent.
 *
 * The id is published to the environment so worker processes, which re-evaluate this config,
 * inherit the same directory instead of each inventing one.
 */
const runId =
  process.env['DAPPERCODE_E2E_RUN_ID'] ?? `${String(Date.now())}-${String(process.pid)}`;
process.env['DAPPERCODE_E2E_RUN_ID'] = runId;
const artifactsRoot = path.join(repoRoot, '.e2e', 'runs', runId);

export default defineConfig({
  globalSetup: './globalSetup.ts',
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  outputDir: path.join(artifactsRoot, 'test-results'),
  snapshotDir: './snapshots',

  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env['CI']
    ? [['list'], ['html', { outputFolder: path.join(artifactsRoot, 'report'), open: 'never' }]]
    : [['list']],

  use: {
    // Layout measurements must be reproducible, so the rendering environment is pinned rather than
    // inherited from whatever machine runs the suite.
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'phone',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: false },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 834, height: 1112 },
        isMobile: false,
      },
    },
  ],
});
