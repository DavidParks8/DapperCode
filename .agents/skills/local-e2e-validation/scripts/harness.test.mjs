import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import { WebSocketServer } from 'ws';

import { createHarness } from './harness.mjs';

function memoryOutput() {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    read: () => value,
  };
}

test('parallel harnesses use disjoint runtime namespaces', async () => {
  const first = createHarness({ name: 'parallel-test', output: memoryOutput().stream });
  const second = createHarness({ name: 'parallel-test', output: memoryOutput().stream });
  try {
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.runId, second.runId);
    const firstFile = first.writeFile('data/owner', 'first');
    const secondFile = second.writeFile('data/owner', 'second');
    assert.equal(first.readFile('data/owner'), 'first');
    assert.equal(second.readFile('data/owner'), 'second');
    assert.notEqual(firstFile, secondFile);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
  assert.equal(existsSync(first.root), false);
  assert.equal(existsSync(second.root), false);
});

test('phase output and failures redact registered secrets', async () => {
  const output = memoryOutput();
  const harness = createHarness({ name: 'redaction-test', output: output.stream });
  const secret = harness.createSecret();
  const escapedSecret = harness.registerSecret('quoted"credential');
  try {
    await assert.rejects(
      harness.phase('secret-failure', async () => {
        throw new Error(`credential=${secret}; escaped=${escapedSecret}`);
      }),
      /\[REDACTED\]/,
    );
    assert.equal(output.read().includes(secret), false);
    assert.equal(output.read().includes('quoted'), false);
    assert.match(output.read(), /\[REDACTED\]/);
  } finally {
    await harness.cleanup();
  }
});

test('scenario contracts require scripted assertions in critical phases', async () => {
  const harness = createHarness({ name: 'contract-test', output: memoryOutput().stream });
  try {
    await harness.phase('baseline', async () => {});
    assert.throws(
      () =>
        harness.verifyContract({
          requiredPhases: ['baseline'],
        }),
      /no scripted assertions/,
    );
    await harness.phase('scenario', async () => {
      await harness.expectEqual('runner wrapper cannot satisfy contract', true, true);
    });
    assert.throws(
      () =>
        harness.verifyContract({
          requiredPhases: ['scenario'],
        }),
      /reserved runner phase/,
    );
    await assert.rejects(
      harness.phase('false-assertion', async () => {
        await harness.check('false predicate', () => false);
      }),
      /assertion returned false/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('swallowed phase and assertion failures remain fatal to the contract and run outcome', async () => {
  const harness = createHarness({ name: 'sticky-failure-test', output: memoryOutput().stream });
  try {
    await harness.phase('baseline', async () => {
      await harness.expectEqual('valid baseline', true, true);
    });
    try {
      await harness.phase('trigger', async () => {
        await harness.expectEqual('reported defect', 'broken', 'healthy');
      });
    } catch {
      // The scenario cannot convert this into success by swallowing it.
    }
    assert.throws(
      () =>
        harness.verifyContract({
          requiredPhases: ['baseline', 'trigger'],
        }),
      /E2E phases failed/,
    );
    assert.throws(() => harness.markPassed(), /cannot mark an E2E run passed/);
  } finally {
    await harness.cleanup();
  }
});

test('run enforces exit codes and exact process cleanup', async () => {
  const harness = createHarness({ name: 'process-test', output: memoryOutput().stream });
  let longRunning;
  try {
    const result = await harness.run(
      process.execPath,
      ['-e', 'process.stdout.write("ok"); process.stderr.write("note")'],
      { label: 'short-command' },
    );
    assert.equal(result.stdout, 'ok');
    assert.equal(result.stderr, 'note');

    await assert.rejects(
      harness.run(process.execPath, ['-e', 'process.exit(7)'], { label: 'failing-command' }),
      /exited 7/,
    );
    await assert.rejects(
      harness.start(path.join(harness.root, 'missing-executable'), [], {
        label: 'missing-command',
      }),
      /ENOENT/,
    );

    longRunning = await harness.start(
      process.execPath,
      ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
      { label: 'long-running' },
    );
    await harness.waitForLog('long-running', /ready/);
    assert.equal(longRunning.isRunning(), true);
    await assert.rejects(longRunning.wait(20), /did not exit/);
  } finally {
    await harness.cleanup();
  }
  assert.equal(longRunning.isRunning(), false);
});

test('run honors command-specific timeouts longer than the harness default', async () => {
  const harness = createHarness({
    name: 'long-timeout-test',
    output: memoryOutput().stream,
    defaultTimeoutMs: 25,
  });
  try {
    const result = await harness.run(
      process.execPath,
      ['-e', 'setTimeout(() => process.stdout.write("done"), 80)'],
      { label: 'long-command', timeoutMs: 500 },
    );
    assert.equal(result.stdout, 'done');
  } finally {
    await harness.cleanup();
  }
});

test('concurrent process starts reserve labels before spawning', async () => {
  const harness = createHarness({ name: 'label-reservation', output: memoryOutput().stream });
  try {
    const [first, second] = await Promise.all([
      harness.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']),
      harness.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']),
    ]);
    assert.notEqual(first.label, second.label);
    assert.notEqual(first.stdoutPath, second.stdoutPath);

    const duplicate = await Promise.allSettled([
      harness.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        label: 'same-label',
      }),
      harness.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        label: 'same-label',
      }),
    ]);
    assert.equal(duplicate.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(duplicate.filter((result) => result.status === 'rejected').length, 1);
    assert.match(
      duplicate.find((result) => result.status === 'rejected').reason.message,
      /duplicate process label/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('waitFor bounds a predicate that never settles', async () => {
  const harness = createHarness({ name: 'predicate-timeout', output: memoryOutput().stream });
  try {
    const started = Date.now();
    await assert.rejects(
      harness.waitFor('hanging predicate', () => new Promise(() => {}), {
        timeoutMs: 75,
        intervalMs: 5,
      }),
      /timed out waiting for hanging predicate/,
    );
    assert.ok(Date.now() - started < 500);
  } finally {
    await harness.cleanup();
  }
});

test('HTTP and WebSocket probes assert real public boundaries', async () => {
  const harness = createHarness({ name: 'transport-test', output: memoryOutput().stream });
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', path: request.url }));
  });
  const webSockets = new WebSocketServer({ server });
  webSockets.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data));
      socket.send(JSON.stringify({ id: request.id, result: { status: 'ok' } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const http = await harness.requestHttp({
      url: `http://127.0.0.1:${String(address.port)}/health`,
      expectJson: { status: 'ok', path: '/health' },
    });
    assert.equal(http.status, 200);

    const socket = await harness.openWebSocket('rpc', `ws://127.0.0.1:${String(address.port)}/rpc`);
    socket.sendJson({ id: 'one', method: 'health' });
    const response = await socket.nextJson({
      predicate: (message) => message.id === 'one',
    });
    assert.deepEqual(response.result, { status: 'ok' });
    await socket.close();
  } finally {
    webSockets.close();
    server.close();
    await once(server, 'close');
    await harness.cleanup();
  }
});

test('leases serialize non-isolatable resources without sharing data', async () => {
  const first = createHarness({ name: 'lease-first', output: memoryOutput().stream });
  const second = createHarness({ name: 'lease-second', output: memoryOutput().stream });
  try {
    const releaseFirst = await first.acquireLease('simulator:example', { timeoutMs: 1_000 });
    let secondAcquired = false;
    const secondLease = second
      .acquireLease('simulator:example', { timeoutMs: 2_000, intervalMs: 20 })
      .then((release) => {
        secondAcquired = true;
        return release;
      });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(secondAcquired, false);
    await releaseFirst();
    const releaseSecond = await secondLease;
    assert.equal(secondAcquired, true);
    await releaseSecond();
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test('run-root path guards reject traversal', async () => {
  const harness = createHarness({ name: 'path-guard', output: memoryOutput().stream });
  try {
    assert.throws(() => harness.resolvePath('..', 'outside'), /escapes E2E root/);
    assert.throws(() => harness.remove('.'), /use cleanup/);
  } finally {
    await harness.cleanup();
  }
  assert.equal(path.dirname(harness.root), harness.tempBase);
});

test('namespaces are bounded and sanitized and evidence can persist outside the run root', async () => {
  const owner = createHarness({ name: 'evidence-owner', output: memoryOutput().stream });
  const evidencePath = owner.resolvePath('logs', 'persisted-evidence.jsonl');
  const harness = createHarness({
    name: 'evidence-source',
    output: memoryOutput().stream,
    evidenceOutputPath: evidencePath,
  });
  try {
    const namespace = harness.namespace('Queue / Topic With Spaces', 32);
    assert.match(namespace, /^[a-z0-9._-]+$/);
    assert.ok(namespace.length <= 32);
    await harness.phase('baseline', async () => {
      await harness.expectEqual(
        'namespace is stable',
        harness.namespace('queue', 32),
        harness.namespace('queue', 32),
      );
    });
    harness.markPassed();
  } finally {
    await harness.cleanup();
  }
  try {
    assert.equal(existsSync(evidencePath), true);
    assert.match(owner.readFile('logs/persisted-evidence.jsonl'), /"event":"run","status":"pass"/);
    assert.throws(
      () =>
        createHarness({
          name: 'evidence-collision',
          output: memoryOutput().stream,
          evidenceOutputPath: evidencePath,
        }),
      /reserve unique evidence path/,
    );
  } finally {
    await owner.cleanup();
  }
});

test('evidence-copy failures still remove the secret-bearing run root', async () => {
  const owner = createHarness({ name: 'bad-evidence-owner', output: memoryOutput().stream });
  owner.writeFile('evidence-parent/placeholder', 'fixture');
  const evidencePath = owner.resolvePath('evidence-parent', 'evidence.jsonl');
  const harness = createHarness({
    name: 'bad-evidence-source',
    output: memoryOutput().stream,
    evidenceOutputPath: evidencePath,
  });
  owner.remove('evidence-parent/evidence.jsonl');
  owner.writeFile('evidence-parent/evidence.jsonl/blocked', 'fixture');
  harness.markPassed();
  await assert.rejects(harness.cleanup(), /E2E cleanup failed/);
  assert.equal(existsSync(harness.root), false);
  await owner.cleanup();
});

test('scenario runner enforces the declared phase contract', async () => {
  const harness = createHarness({ name: 'runner-test', output: memoryOutput().stream });
  try {
    const scenarioPath = harness.writeFile(
      'scenario.mjs',
      `
export const name = 'runner-contract';
export const contract = {
  requiredPhases: ['baseline', 'confirmation'],
};
export default async function scenario(e2e) {
  await e2e.phase('baseline', async () => {
    await e2e.expectEqual('baseline value', 2 + 2, 4);
  });
  await e2e.phase('confirmation', async () => {
    await e2e.expectSubset('confirmation value', { ok: true, extra: 1 }, { ok: true });
  });
}
`,
    );
    const runnerPath = path.resolve('.agents/skills/local-e2e-validation/scripts/run.mjs');
    const evidencePath = harness.resolvePath('logs', 'runner-evidence.jsonl');
    const result = await harness.run(
      process.execPath,
      [runnerPath, '--evidence', evidencePath, scenarioPath],
      {
        label: 'scenario-runner',
        cwd: process.cwd(),
      },
    );
    assert.match(result.stdout, /"event":"contract","status":"pass"/);
    assert.match(harness.readFile('logs/runner-evidence.jsonl'), /"event":"run","status":"pass"/);
  } finally {
    await harness.cleanup();
  }
});

test('failed scenarios persist a terminal failed run outcome', async () => {
  const harness = createHarness({ name: 'failed-runner-test', output: memoryOutput().stream });
  try {
    const scenarioPath = harness.writeFile(
      'failed-scenario.mjs',
      `
export const name = 'failed-runner-contract';
export const contract = { requiredPhases: ['baseline'] };
export default async function scenario(e2e) {
  await e2e.phase('baseline', async () => {
    await e2e.expectEqual('reported value', 'broken', 'ok');
  });
}
`,
    );
    const runnerPath = path.resolve('.agents/skills/local-e2e-validation/scripts/run.mjs');
    const evidencePath = harness.resolvePath('logs', 'failed-runner-evidence.jsonl');
    const result = await harness.run(
      process.execPath,
      [runnerPath, '--evidence', evidencePath, scenarioPath],
      {
        label: 'failed-scenario-runner',
        cwd: process.cwd(),
        expectExitCodes: [1],
      },
    );
    assert.match(result.stderr, /E2E scenario failed/);
    const records = harness
      .readFile('logs/failed-runner-evidence.jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.at(-1).event, 'run');
    assert.equal(records.at(-1).status, 'fail');
  } finally {
    await harness.cleanup();
  }
});

test('separate runner processes execute the same scenario without clashing', async () => {
  const harness = createHarness({ name: 'parallel-runners', output: memoryOutput().stream });
  try {
    const scenarioPath = harness.writeFile(
      'parallel-scenario.mjs',
      `
export const name = 'parallel-scenario';
export const contract = {
  requiredPhases: ['baseline', 'confirmation'],
};
export default async function scenario(e2e) {
  await e2e.phase('baseline', async () => {
    e2e.writeFile('data/owner', e2e.runId);
    await e2e.expectEqual('owns isolated data', e2e.readFile('data/owner'), e2e.runId);
  });
  await e2e.phase('confirmation', async () => {
    await e2e.expectEqual('run root remains isolated', e2e.readFile('data/owner'), e2e.runId);
  });
}
`,
    );
    const runnerPath = path.resolve('.agents/skills/local-e2e-validation/scripts/run.mjs');
    const [first, second] = await Promise.all([
      harness.run(process.execPath, [runnerPath, scenarioPath], {
        label: 'parallel-runner-a',
        cwd: process.cwd(),
      }),
      harness.run(process.execPath, [runnerPath, scenarioPath], {
        label: 'parallel-runner-b',
        cwd: process.cwd(),
      }),
    ]);
    const firstRun = JSON.parse(first.stdout.split('\n')[0]);
    const secondRun = JSON.parse(second.stdout.split('\n')[0]);
    assert.notEqual(firstRun.runId, secondRun.runId);
    assert.equal(first.stdout.includes('"status":"fail"'), false);
    assert.equal(second.stdout.includes('"status":"fail"'), false);
    assert.equal(existsSync(path.join(harness.tempBase, firstRun.runId)), false);
    assert.equal(existsSync(path.join(harness.tempBase, secondRun.runId)), false);
  } finally {
    await harness.cleanup();
  }
});

test('launcher exit drains background descendants from its process group', async () => {
  const harness = createHarness({ name: 'process-group-drain', output: memoryOutput().stream });
  try {
    const pidPath = harness.resolvePath('data', 'descendant.pid');
    const launcherPath = harness.writeFile(
      'launcher.cjs',
      `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
child.unref();
`,
    );
    const launcher = await harness.start(process.execPath, [launcherPath], {
      label: 'daemonizing-launcher',
    });
    await launcher.wait();
    const descendantPid = Number(harness.readFile('data/descendant.pid'));
    await harness.waitFor('background descendant to be terminated', () => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    });
  } finally {
    await harness.cleanup();
  }
});

test('process-group cleanup tolerates transient EPERM after the leader exits', async () => {
  const harness = createHarness({ name: 'process-group-eperm', output: memoryOutput().stream });
  const child = await harness.start(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], {
    label: 'short-lived-group',
  });
  const originalKill = process.kill;
  let zeroProbes = 0;
  process.kill = (pid, signal) => {
    if (pid === -child.pid) {
      if (signal === 0) {
        zeroProbes += 1;
        if (zeroProbes <= 2) {
          return;
        }
        const error = new Error('process group no longer exists');
        error.code = 'ESRCH';
        throw error;
      }
      if (signal === 'SIGTERM') {
        const error = new Error('process group is temporarily unsignalable');
        error.code = 'EPERM';
        throw error;
      }
    }
    return originalKill(pid, signal);
  };
  try {
    await child.wait();
    await harness.cleanup();
    assert.ok(zeroProbes >= 3);
    assert.equal(existsSync(harness.root), false);
  } finally {
    process.kill = originalKill;
  }
});

test('lease ports are released by the OS after a hard crash', async () => {
  const owner = createHarness({ name: 'stale-lease-owner', output: memoryOutput().stream });
  const claimant = createHarness({ name: 'stale-lease-claimant', output: memoryOutput().stream });
  const resource = `simulator:${owner.runId}`;
  try {
    const harnessUrl = new URL('./harness.mjs', import.meta.url).href;
    const victimPath = owner.writeFile(
      'lease-victim.mjs',
      `
import { createHarness } from ${JSON.stringify(harnessUrl)};
const harness = createHarness({ name: 'lease-victim' });
await harness.acquireLease(${JSON.stringify(resource)});
process.stdout.write('lease-ready\\\\n');
setInterval(() => {}, 1000);
`,
    );
    const victim = await owner.start(process.execPath, [victimPath], {
      label: 'lease-victim',
    });
    await owner.waitForLog('lease-victim', /lease-ready/);
    process.kill(victim.pid, 'SIGKILL');
    await victim.wait();

    const release = await claimant.acquireLease(resource, {
      timeoutMs: 2_000,
      intervalMs: 20,
    });
    await release();
  } finally {
    await Promise.all([owner.cleanup(), claimant.cleanup()]);
  }
});

test('simultaneous claimants cannot overlap after a crashed lease owner', async () => {
  const owner = createHarness({ name: 'lease-race-owner', output: memoryOutput().stream });
  const claimants = Array.from({ length: 4 }, (_, index) =>
    createHarness({ name: `lease-race-${String(index)}`, output: memoryOutput().stream }),
  );
  const resource = `simulator:${owner.runId}`;
  try {
    const harnessUrl = new URL('./harness.mjs', import.meta.url).href;
    const victimPath = owner.writeFile(
      'lease-race-victim.mjs',
      `
import { createHarness } from ${JSON.stringify(harnessUrl)};
const harness = createHarness({ name: 'lease-race-victim' });
await harness.acquireLease(${JSON.stringify(resource)});
process.stdout.write('lease-ready\\\\n');
setInterval(() => {}, 1000);
`,
    );
    const victim = await owner.start(process.execPath, [victimPath], {
      label: 'lease-race-victim',
    });
    await owner.waitForLog('lease-race-victim', /lease-ready/);
    process.kill(victim.pid, 'SIGKILL');
    await victim.wait();

    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      claimants.map(async (claimant) => {
        const release = await claimant.acquireLease(resource, {
          timeoutMs: 4_000,
          intervalMs: 10,
        });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        await release();
      }),
    );
    assert.equal(maximumActive, 1);
  } finally {
    await Promise.all([owner.cleanup(), ...claimants.map((claimant) => claimant.cleanup())]);
  }
});

test('signal cleanup rejects late process creation and records an aborted run', async () => {
  const harness = createHarness({ name: 'signal-runner-test', output: memoryOutput().stream });
  try {
    const lateMarker = harness.resolvePath('data', 'late-process-started');
    const lateProcessCode = `require('node:fs').writeFileSync(${JSON.stringify(lateMarker)}, 'started')`;
    const scenarioPath = harness.writeFile(
      'signal-scenario.mjs',
      `
export const name = 'signal-cleanup';
export const contract = { requiredPhases: ['setup'] };
export default async function scenario(e2e) {
  await e2e.phase('setup', async () => {
    await e2e.start(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ], { label: 'slow-cleanup-child' });
    await e2e.expectEqual('first process started', true, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await e2e.start(process.execPath, [
      '-e',
      ${JSON.stringify(lateProcessCode)},
    ], { label: 'late-child' });
  });
}
`,
    );
    const runnerPath = path.resolve('.agents/skills/local-e2e-validation/scripts/run.mjs');
    const evidencePath = harness.resolvePath('logs', 'aborted-evidence.jsonl');
    const runner = await harness.start(
      process.execPath,
      [runnerPath, '--evidence', evidencePath, scenarioPath],
      { label: 'signal-runner', cwd: process.cwd() },
    );
    await harness.waitForLog('signal-runner', /"phase":"setup","status":"start"/);
    process.kill(runner.pid, 'SIGTERM');
    const result = await runner.wait(6_000);
    assert.equal(result.code, 143);
    assert.equal(existsSync(lateMarker), false);
    const records = harness
      .readFile('logs/aborted-evidence.jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.at(-1).status, 'aborted');
  } finally {
    await harness.cleanup();
  }
});
