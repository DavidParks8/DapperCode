#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { prepareCargoTarget } from './cargo-target-cache.mjs';

const args = process.argv.slice(2);
const prepared = prepareCargoTarget();

try {
  if (args.length === 1 && args[0] === '--print-target-dir') {
    process.stdout.write(`${prepared.targetDir ?? ''}\n`);
    process.exitCode = 0;
  } else {
    const result = spawnSync('cargo', args, {
      cwd: process.cwd(),
      env: prepared.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} finally {
  prepared.release();
}
