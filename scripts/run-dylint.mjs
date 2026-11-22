#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { prepareCargoTarget } from './cargo-target-cache.mjs';

const DYLINT_VERSION = '6.4.0';
const DEFAULT_WORKSPACES = ['services/rust-bridge', 'apps/desktop'];

const parseArgs = (argv) => {
  const workspaces = [];
  const passthrough = [];
  let inPassthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (inPassthrough) {
      passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      inPassthrough = true;
      continue;
    }
    if (arg === '--workspace') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--workspace requires a relative workspace path');
      }
      workspaces.push(next);
      index += 1;
      continue;
    }
    passthrough.push(arg);
  }

  return {
    workspaces: workspaces.length > 0 ? workspaces : DEFAULT_WORKSPACES,
    passthrough,
  };
};

const assertCargoDylintAvailable = () => {
  try {
    execFileSync('cargo', ['dylint', '--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `cargo-dylint ${DYLINT_VERSION} is required for Rust Dylint checks. Install cargo-dylint and dylint-link ${DYLINT_VERSION} (for example: cargo +stable install cargo-dylint@${DYLINT_VERSION} dylint-link@${DYLINT_VERSION} --locked).`,
    );
  }
};

const assertDylintLinkAvailable = () => {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates =
    process.platform === 'win32' ? ['dylint-link.exe', 'dylint-link'] : ['dylint-link'];
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      try {
        accessSync(path.join(directory, candidate), constants.X_OK);
        return;
      } catch {
        // Keep checking PATH entries.
      }
    }
  }
  throw new Error(
    `dylint-link ${DYLINT_VERSION} is required for Rust Dylint checks. Install cargo-dylint and dylint-link ${DYLINT_VERSION} (for example: cargo +stable install cargo-dylint@${DYLINT_VERSION} dylint-link@${DYLINT_VERSION} --locked).`,
  );
};

const { workspaces, passthrough } = parseArgs(process.argv.slice(2));
assertCargoDylintAvailable();
assertDylintLinkAvailable();

const prepared = prepareCargoTarget();
const env = {
  ...prepared.env,
  DYLINT_RUSTFLAGS: prepared.env.DYLINT_RUSTFLAGS ?? '-D warnings',
};

try {
  for (const workspace of workspaces) {
    const manifestPath = path.join(workspace, 'Cargo.toml');
    const args = [
      'dylint',
      '--lib',
      'perfectionist',
      '--manifest-path',
      manifestPath,
      '--',
      '--locked',
      '--workspace',
      '--all-targets',
      '--all-features',
      ...passthrough,
    ];
    const result = spawnSync('cargo', args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  prepared.release();
}
