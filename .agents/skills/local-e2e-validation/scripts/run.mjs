#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createHarness } from './harness.mjs';

function usage() {
  process.stderr.write(
    'Usage: node .agents/skills/local-e2e-validation/scripts/run.mjs [--keep-artifacts] [--evidence PATH] <scenario.mjs>\n',
  );
}

const argumentsList = process.argv.slice(2);
const keepArtifactsIndex = argumentsList.indexOf('--keep-artifacts');
const keepArtifacts = keepArtifactsIndex >= 0;
if (keepArtifacts) {
  argumentsList.splice(keepArtifactsIndex, 1);
}
const evidenceIndex = argumentsList.indexOf('--evidence');
let evidenceOutputPath = null;
if (evidenceIndex >= 0) {
  evidenceOutputPath = argumentsList[evidenceIndex + 1];
  if (!evidenceOutputPath) {
    usage();
    process.exit(2);
  }
  argumentsList.splice(evidenceIndex, 2);
}
if (argumentsList.length !== 1) {
  usage();
  process.exit(2);
}

const scenarioPath = path.resolve(argumentsList[0]);
const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 5_000,
});
if (gitRoot.status !== 0 || !gitRoot.stdout.trim()) {
  process.stderr.write('Run the E2E scenario from inside its isolated git worktree.\n');
  process.exit(1);
}
let scenarioModule;
try {
  scenarioModule = await import(pathToFileURL(scenarioPath).href);
} catch (error) {
  process.stderr.write(`Could not load E2E scenario: ${error.message}\n`);
  process.exit(1);
}
if (typeof scenarioModule.default !== 'function') {
  process.stderr.write('E2E scenario must default-export an async function.\n');
  process.exit(1);
}
if (!scenarioModule.contract || typeof scenarioModule.contract !== 'object') {
  process.stderr.write('E2E scenario must export a deterministic contract object.\n');
  process.exit(1);
}

const harness = createHarness({
  name: scenarioModule.name ?? path.basename(scenarioPath, path.extname(scenarioPath)),
  keepArtifacts,
  worktree: gitRoot.stdout.trim(),
  evidenceOutputPath,
});
let signalReceived = null;
let terminating = false;
const terminate = async (outcome, reason, exitCode) => {
  if (terminating) {
    return;
  }
  terminating = true;
  if (outcome === 'aborted') {
    harness.markAborted(reason);
  } else {
    harness.markFailed(reason);
  }
  process.stderr.write(`E2E ${outcome}: ${harness.redact(reason.message ?? reason)}\n`);
  try {
    await harness.cleanup();
  } catch (error) {
    process.stderr.write(`${harness.redact(error.message)}\n`);
  }
  process.exit(exitCode);
};
const handleSignal = (signal) => {
  signalReceived = signal;
  void terminate('aborted', signal, signal === 'SIGINT' ? 130 : 143);
};
const handleUncaughtException = (error) => {
  void terminate('failed', error, 1);
};
const handleUnhandledRejection = (reason) => {
  void terminate('failed', reason, 1);
};
process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);
process.once('uncaughtException', handleUncaughtException);
process.once('unhandledRejection', handleUnhandledRejection);

try {
  await harness.phase('scenario', async () => {
    await scenarioModule.default(harness);
    harness.verifyContract(scenarioModule.contract);
    if (signalReceived) {
      throw new Error(`received ${signalReceived}`);
    }
  });
  harness.markPassed();
} catch (error) {
  if (!terminating) {
    harness.markFailed(error);
    process.stderr.write(`E2E scenario failed: ${harness.redact(error.message)}\n`);
    process.exitCode = 1;
  }
} finally {
  if (!terminating) {
    try {
      await harness.cleanup();
    } catch (error) {
      process.stderr.write(`${harness.redact(error.message)}\n`);
      process.exitCode = 1;
    }
    if (keepArtifacts) {
      process.stderr.write(
        `E2E artifacts retained at ${harness.root}; remove that run root after debugging.\n`,
      );
    }
  }
  process.removeListener('SIGINT', handleSignal);
  process.removeListener('SIGTERM', handleSignal);
  process.removeListener('uncaughtException', handleUncaughtException);
  process.removeListener('unhandledRejection', handleUnhandledRejection);
}
