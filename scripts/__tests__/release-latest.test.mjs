import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '../..');
const script = path.join(rootDir, 'scripts/release-latest.mts');

test('release:latest dry run describes the complete release workflow', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, '--dry-run'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fast-forward to origin\/main/i);
  assert.match(result.stdout, /in parallel/i);
  assert.match(result.stdout, /desktop:build:macos/);
  assert.match(result.stdout, /local iOS production EAS build/i);
  assert.match(result.stdout, /submit the generated IPA to TestFlight/i);
});

function writeExecutable(directory, name, contents) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function readEventTimestamp(events, name) {
  const entry = events.find((event) => event.name === name);
  assert.ok(entry, `missing ${name} event in ${JSON.stringify(events)}`);
  return entry.timestamp;
}

test(
  'release:latest runs the tray build and TestFlight build in parallel',
  { skip: process.platform !== 'darwin' },
  () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'release-latest-test-'));
    const binDirectory = path.join(temporaryDirectory, 'bin');
    const logFile = path.join(temporaryDirectory, 'events.log');

    mkdirSync(binDirectory);
    writeFileSync(logFile, '');

    try {
      writeExecutable(
        binDirectory,
        'git',
        `#!/usr/bin/env node
const args = process.argv.slice(2);
switch (args[0]) {
  case 'diff':
  case 'fetch':
  case 'merge':
    process.exit(0);
  case 'rev-parse':
    process.stdout.write('abcdef1234567890\\n');
    process.exit(0);
  default:
    process.stderr.write(\`unexpected git args: \${args.join(' ')}\\n\`);
    process.exit(1);
}
`,
      );
      writeExecutable(
        binDirectory,
        'pnpm',
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') === 'run desktop:build:macos') {
  fs.appendFileSync(process.env.LOG_FILE, \`\${Date.now()} pnpm-tray-start\\n\`);
  setTimeout(() => {
    fs.appendFileSync(process.env.LOG_FILE, \`\${Date.now()} pnpm-tray-end\\n\`);
    process.exit(0);
  }, 300);
  return;
}
const outputIndex = args.indexOf('--output');
if (args.slice(0, 3).join(' ') === 'dlx eas-cli build') {
  fs.appendFileSync(process.env.LOG_FILE, \`\${Date.now()} pnpm-build-start\\n\`);
  setTimeout(() => {
    const archivePath = args[outputIndex + 1];
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, 'ipa');
    fs.appendFileSync(process.env.LOG_FILE, \`\${Date.now()} pnpm-build-end\\n\`);
    process.exit(0);
  }, 300);
  return;
}
if (args.slice(0, 3).join(' ') === 'dlx eas-cli submit') {
  fs.appendFileSync(process.env.LOG_FILE, \`\${Date.now()} pnpm-submit-start\\n\`);
  setTimeout(() => {
    fs.appendFileSync(process.env.LOG_FILE, \`\${Date.now()} pnpm-submit-end\\n\`);
    process.exit(0);
  }, 50);
  return;
}
process.stderr.write(\`unexpected pnpm args: \${args.join(' ')}\\n\`);
process.exit(1);
`,
      );
      writeExecutable(
        binDirectory,
        'open',
        `#!/usr/bin/env node
process.exit(0);
`,
      );
      writeExecutable(
        binDirectory,
        'sleep',
        `#!/usr/bin/env node
setTimeout(() => process.exit(0), 10);
`,
      );
      writeExecutable(
        binDirectory,
        'pgrep',
        `#!/usr/bin/env node
process.stdout.write('123\\n');
`,
      );

      const result = spawnSync(process.execPath, ['--experimental-strip-types', script], {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          LOG_FILE: logFile,
          PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Tray app running \(123\)/);
      assert.match(result.stdout, /TestFlight submission scheduled/i);

      const events = readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [timestamp, name] = line.split(' ');
          return { timestamp: Number(timestamp), name };
        });

      const trayStart = readEventTimestamp(events, 'pnpm-tray-start');
      const trayEnd = readEventTimestamp(events, 'pnpm-tray-end');
      const buildStart = readEventTimestamp(events, 'pnpm-build-start');
      const buildEnd = readEventTimestamp(events, 'pnpm-build-end');
      const submitStart = readEventTimestamp(events, 'pnpm-submit-start');

      assert.ok(
        Math.max(trayStart, buildStart) < Math.min(trayEnd, buildEnd),
        `expected overlapping build windows, got ${JSON.stringify(events)}`,
      );
      assert.ok(
        submitStart >= buildEnd,
        `expected submit to wait for archive creation, got ${JSON.stringify(events)}`,
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
);
