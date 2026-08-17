import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 100;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const OWNER_MARKER = '.local-e2e-owner.json';
const OWNER_KIND = 'local-e2e-validation-v1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeName(value, fallback = 'item') {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function captureTail(value, maxBytes = 16 * 1024) {
  const text = String(value ?? '');
  return Buffer.byteLength(text) <= maxBytes ? text : text.slice(-maxBytes);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function processGroupIsAlive(processGroupId) {
  if (process.platform === 'win32') {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function removeStaleRunRoot(tempBase, candidateRoot, expectedPid = null) {
  try {
    const root = realpathSync(candidateRoot);
    if (realpathSync(path.dirname(root)) !== tempBase) {
      return false;
    }
    const owner = JSON.parse(readFileSync(path.join(root, OWNER_MARKER), 'utf8'));
    if (
      owner.kind !== OWNER_KIND ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.preserve === true ||
      (expectedPid !== null && owner.pid !== expectedPid) ||
      processIsAlive(owner.pid)
    ) {
      return false;
    }
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanStaleRunRoots(tempBase) {
  let entries;
  try {
    entries = readdirSync(tempBase, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeStaleRunRoot(tempBase, path.join(tempBase, entry.name));
    }
  }
}

function assertSubset(actual, expected, location = '$') {
  if (Array.isArray(expected)) {
    assert.deepEqual(actual, expected, `unexpected value at ${location}`);
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `expected object at ${location}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `missing ${location}.${key}`);
      assertSubset(actual[key], value, `${location}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, `unexpected value at ${location}`);
}

class TrackedWebSocket {
  constructor(harness, label, rawSocket) {
    this.harness = harness;
    this.label = label;
    this.rawSocket = rawSocket;
    this.messages = [];
    this.waiters = [];
    this.lastError = null;
    this.closed = false;
    this.opened = false;

    this.openPromise = new Promise((resolve, reject) => {
      rawSocket.once('open', () => {
        this.opened = true;
        resolve();
      });
      rawSocket.once('unexpected-response', (_request, response) => {
        reject(new Error(`WebSocket upgrade returned HTTP ${String(response.statusCode)}`));
      });
      rawSocket.once('error', reject);
    });
    this.closePromise = new Promise((resolve) => {
      rawSocket.once('close', (code, reason) => {
        this.closed = true;
        this.#rejectWaiters(new Error(`WebSocket closed with code ${String(code)}`));
        resolve({ code, reason: String(reason) });
      });
    });
    rawSocket.on('message', (data) => this.#dispatch(String(data)));
    rawSocket.on('error', (error) => {
      this.lastError = error;
      this.#rejectWaiters(error);
    });
  }

  async waitForOpen(timeoutMs) {
    await withTimeout(
      this.openPromise,
      timeoutMs,
      `WebSocket ${this.label} did not open within ${String(timeoutMs)}ms`,
    );
    return this;
  }

  send(value) {
    if (!this.opened || this.closed) {
      throw new Error(`WebSocket ${this.label} is not open`);
    }
    this.rawSocket.send(value);
  }

  sendJson(value) {
    this.send(JSON.stringify(value));
  }

  async nextMessage({ predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const existingIndex = this.messages.findIndex((value) => predicate(value));
    if (existingIndex >= 0) {
      return this.messages.splice(existingIndex, 1)[0];
    }
    if (this.closed) {
      throw new Error(`WebSocket ${this.label} is closed`);
    }
    return await new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(
          new Error(`WebSocket ${this.label} message wait timed out after ${String(timeoutMs)}ms`),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async nextJson({ predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const raw = await this.nextMessage({
      timeoutMs,
      predicate: (value) => {
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          return false;
        }
        return predicate(parsed);
      },
    });
    return JSON.parse(raw);
  }

  async waitForClose(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return await withTimeout(
      this.closePromise,
      timeoutMs,
      `WebSocket ${this.label} did not close within ${String(timeoutMs)}ms`,
    );
  }

  async close() {
    if (this.closed) {
      return;
    }
    if (this.rawSocket.readyState === this.rawSocket.OPEN) {
      this.rawSocket.close(1000, 'E2E cleanup');
      try {
        await this.waitForClose(1_000);
        return;
      } catch {
        // Force termination below.
      }
    }
    this.rawSocket.terminate();
    await this.waitForClose(1_000);
  }

  #dispatch(value) {
    const waiterIndex = this.waiters.findIndex((waiter) => {
      try {
        return waiter.predicate(value);
      } catch (error) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
        return true;
      }
    });
    if (waiterIndex < 0) {
      this.messages.push(value);
      return;
    }
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  #rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export class E2EHarness {
  constructor({
    name = 'project-e2e',
    worktree = process.cwd(),
    keepArtifacts = false,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    output = process.stdout,
    evidenceOutputPath = null,
  } = {}) {
    this.name = safeName(name, 'project-e2e');
    this.worktree = realpathSync(worktree);
    this.keepArtifacts = keepArtifacts;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.output = output;
    this.evidenceOutputPath = evidenceOutputPath ? path.resolve(evidenceOutputPath) : null;
    this.systemTempBase = realpathSync(os.tmpdir());
    const runBase = path.join(this.systemTempBase, 'local-e2e-validation-runs');
    mkdirSync(runBase, { recursive: true, mode: 0o700 });
    this.tempBase = realpathSync(runBase);
    cleanStaleRunRoots(this.tempBase);
    this.root = realpathSync(mkdtempSync(path.join(this.tempBase, `${this.name}.`)));
    if (this.evidenceOutputPath && isInside(this.root, this.evidenceOutputPath)) {
      rmSync(this.root, { recursive: true, force: true });
      throw new Error('persistent evidence path must be outside the temporary E2E root');
    }
    if (this.evidenceOutputPath) {
      try {
        mkdirSync(path.dirname(this.evidenceOutputPath), { recursive: true });
        const evidenceFile = openSync(this.evidenceOutputPath, 'wx', 0o600);
        closeSync(evidenceFile);
      } catch (error) {
        rmSync(this.root, { recursive: true, force: true });
        throw new Error(`could not reserve unique evidence path: ${error.message}`);
      }
    }
    writeFileSync(
      path.join(this.root, OWNER_MARKER),
      JSON.stringify({
        kind: OWNER_KIND,
        pid: process.pid,
        runId: path.basename(this.root),
        preserve: false,
      }),
      { mode: 0o600 },
    );
    this.runId = path.basename(this.root);
    this.dataDir = this.resolvePath('data');
    this.workspaceDir = this.resolvePath('workspace');
    this.logDir = this.resolvePath('logs');
    this.runtimeDir = this.resolvePath('runtime');
    this.evidencePath = this.resolvePath('logs', 'evidence.jsonl');
    for (const directory of [this.dataDir, this.workspaceDir, this.logDir, this.runtimeDir]) {
      mkdirSync(directory, { recursive: true });
    }
    this.processes = new Map();
    this.processOrder = [];
    this.processSequence = 0;
    this.sockets = new Set();
    this.leases = new Map();
    this.secrets = new Set();
    this.phaseNames = new Set();
    this.phaseAssertions = new Map();
    this.failedPhases = new Set();
    this.failedAssertions = [];
    this.activePhase = null;
    this.sequence = 0;
    this.cleanupStarted = false;
    this.runOutcome = 'incomplete';
    this.runError = null;
    this.emit({ event: 'run', status: 'start' });
  }

  resolvePath(...segments) {
    const candidate = path.resolve(this.root, ...segments);
    if (!isInside(this.root, candidate)) {
      throw new Error(`path escapes E2E root: ${candidate}`);
    }
    return candidate;
  }

  registerSecret(value) {
    const normalized = String(value);
    if (normalized) {
      this.secrets.add(normalized);
    }
    return normalized;
  }

  markPassed() {
    this.#setOutcome('pass');
  }

  markFailed(error) {
    this.#setOutcome('fail', error);
  }

  markAborted(reason) {
    this.#setOutcome('aborted', reason);
  }

  createSecret(bytes = 32) {
    assert.ok(Number.isInteger(bytes) && bytes >= 16, 'secret size must be at least 16 bytes');
    return this.registerSecret(randomBytes(bytes).toString('base64url'));
  }

  namespace(label, maxLength = 63) {
    assert.ok(Number.isInteger(maxLength) && maxLength >= 16, 'namespace limit is too small');
    const base = safeName(`${label}-${this.runId}`, 'e2e');
    if (base.length <= maxLength) {
      return base;
    }
    const digest = createHash('sha256').update(base).digest('hex').slice(0, 10);
    return `${base.slice(0, maxLength - digest.length - 1)}-${digest}`;
  }

  redact(value) {
    let text = String(value ?? '');
    const secrets = [...this.secrets].sort((left, right) => right.length - left.length);
    for (const secret of secrets) {
      text = text.replaceAll(secret, '[REDACTED]');
    }
    return text;
  }

  emit(payload) {
    const record = {
      runId: this.runId,
      sequence: ++this.sequence,
      ...payload,
    };
    const encoded = `${JSON.stringify(this.#redactStructured(record))}\n`;
    appendFileSync(this.evidencePath, encoded, { mode: 0o600 });
    this.output.write(encoded);
  }

  async phase(name, operation) {
    this.#assertAcceptingResources();
    const phase = safeName(name, 'phase');
    if (this.phaseNames.has(phase)) {
      throw new Error(`duplicate E2E phase: ${phase}`);
    }
    this.phaseNames.add(phase);
    this.phaseAssertions.set(phase, 0);
    const previousPhase = this.activePhase;
    this.activePhase = phase;
    this.emit({ event: 'phase', phase, status: 'start' });
    try {
      const result = await operation();
      this.emit({
        event: 'phase',
        phase,
        status: 'pass',
        assertions: this.phaseAssertions.get(phase),
      });
      return result;
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : error);
      this.failedPhases.add(phase);
      this.emit({ event: 'phase', phase, status: 'fail', error: message });
      throw new Error(`${phase}: ${message}`);
    } finally {
      this.activePhase = previousPhase;
    }
  }

  async check(name, assertion) {
    this.#assertAcceptingResources();
    if (!this.activePhase) {
      throw new Error('E2E assertions must run inside a phase');
    }
    const check = safeName(name, 'assertion');
    try {
      const result = await assertion();
      if (result === false) {
        throw new Error(`assertion returned false: ${check}`);
      }
      this.phaseAssertions.set(
        this.activePhase,
        (this.phaseAssertions.get(this.activePhase) ?? 0) + 1,
      );
      this.emit({
        event: 'assertion',
        phase: this.activePhase,
        assertion: check,
        status: 'pass',
      });
      return result;
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : error);
      this.failedAssertions.push({
        phase: this.activePhase,
        assertion: check,
        error: message,
      });
      this.emit({
        event: 'assertion',
        phase: this.activePhase,
        assertion: check,
        status: 'fail',
        error: message,
      });
      throw error;
    }
  }

  expectEqual(name, actual, expected) {
    return this.check(name, () => assert.deepEqual(actual, expected));
  }

  expectMatch(name, actual, pattern) {
    return this.check(name, () => assert.match(String(actual), pattern));
  }

  expectSubset(name, actual, expected) {
    return this.check(name, () => assertSubset(actual, expected));
  }

  verifyContract(contract) {
    assert.ok(contract && typeof contract === 'object', 'scenario contract is required');
    const requiredPhases = contract.requiredPhases ?? [];
    assert.ok(Array.isArray(requiredPhases), 'requiredPhases must be an array');
    assert.ok(requiredPhases.length > 0, 'scenario contract must require at least one phase');
    assert.equal(
      this.failedPhases.size,
      0,
      `E2E phases failed: ${[...this.failedPhases].join(', ')}`,
    );
    assert.equal(
      this.failedAssertions.length,
      0,
      `E2E assertions failed: ${this.failedAssertions
        .map((failure) => `${failure.phase}/${failure.assertion}`)
        .join(', ')}`,
    );
    assert.equal(
      new Set(requiredPhases).size,
      requiredPhases.length,
      'requiredPhases contains duplicates',
    );
    for (const phase of requiredPhases) {
      assert.notEqual(phase, 'scenario', 'scenario is a reserved runner phase');
      assert.equal(phase, safeName(phase), `phase name must already be normalized: ${phase}`);
      assert.ok(this.phaseNames.has(phase), `required E2E phase did not run: ${phase}`);
      assert.ok(
        (this.phaseAssertions.get(phase) ?? 0) > 0,
        `required E2E phase has no scripted assertions: ${phase}`,
      );
    }
    this.emit({
      event: 'contract',
      status: 'pass',
      requiredPhases,
      assertions: requiredPhases.reduce(
        (total, phase) => total + (this.phaseAssertions.get(phase) ?? 0),
        0,
      ),
    });
  }

  writeFile(relativePath, contents, options = {}) {
    this.#assertAcceptingResources();
    const destination = this.resolvePath(relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents, { mode: options.mode ?? 0o600 });
    return destination;
  }

  readFile(relativePath, encoding = 'utf8') {
    return readFileSync(this.resolvePath(relativePath), encoding);
  }

  readJson(relativePath) {
    return JSON.parse(this.readFile(relativePath));
  }

  remove(relativePath) {
    this.#assertAcceptingResources();
    const target = this.resolvePath(relativePath);
    if (target === this.root) {
      throw new Error('use cleanup() to remove the E2E root');
    }
    rmSync(target, { recursive: true, force: true });
  }

  copyIntoRun(source, relativeDestination) {
    this.#assertAcceptingResources();
    const destination = this.resolvePath(relativeDestination);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    return destination;
  }

  async run(command, args = [], options = {}) {
    const label = options.label ?? this.#nextProcessLabel('command');
    const handle = await this.start(command, args, {
      ...options,
      label,
      capture: true,
    });
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    let result;
    try {
      result = await handle.wait(timeoutMs);
    } catch (error) {
      await handle.stop();
      throw error;
    }
    const expected = options.expectExitCodes ?? [0];
    if (!expected.includes(result.code)) {
      throw new Error(
        `${label} exited ${String(result.code)}\n${this.redact(captureTail(result.stderr || result.stdout))}`,
      );
    }
    return result;
  }

  async start(command, args = [], options = {}) {
    this.#assertAcceptingResources();
    const label = safeName(
      options.label ?? this.#nextProcessLabel(path.basename(command)),
      'process',
    );
    if (this.processes.has(label)) {
      throw new Error(`duplicate process label: ${label}`);
    }
    const cwd = realpathSync(options.cwd ?? this.worktree);
    if (!isInside(this.worktree, cwd) && !isInside(this.root, cwd)) {
      throw new Error(`process cwd is outside the current worktree and E2E root: ${cwd}`);
    }
    const stdoutPath = this.resolvePath('logs', `${label}.stdout.log`);
    const stderrPath = this.resolvePath('logs', `${label}.stderr.log`);
    const stdoutLog = createWriteStream(stdoutPath, { flags: 'a', mode: 0o600 });
    const stderrLog = createWriteStream(stderrPath, { flags: 'a', mode: 0o600 });
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.pipe(stdoutLog);
    child.stderr.pipe(stderrLog);
    if (options.capture) {
      child.stdout.on('data', (chunk) => {
        if (stdoutBytes < MAX_CAPTURE_BYTES) {
          const bounded = chunk.subarray(0, MAX_CAPTURE_BYTES - stdoutBytes);
          stdoutChunks.push(bounded);
          stdoutBytes += bounded.length;
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderrBytes < MAX_CAPTURE_BYTES) {
          const bounded = chunk.subarray(0, MAX_CAPTURE_BYTES - stderrBytes);
          stderrChunks.push(bounded);
          stderrBytes += bounded.length;
        }
      });
    }
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else if (!options.keepStdinOpen) {
      child.stdin.end();
    }

    let exited = false;
    let exitResult = null;
    let groupCleanupPromise = Promise.resolve();
    child.once('exit', () => {
      if (process.platform !== 'win32' && child.pid) {
        groupCleanupPromise = this.#drainProcessGroup(child.pid);
      }
    });
    const exitPromise = new Promise((resolve) => {
      child.once('error', (error) => {
        exited = true;
        exitResult = {
          code: null,
          signal: null,
          error,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutPath,
          stderrPath,
        };
        resolve(exitResult);
      });
      child.once('close', (code, signal) => {
        exited = true;
        exitResult = {
          code,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutPath,
          stderrPath,
        };
        resolve(exitResult);
      });
    });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readyPromise.catch(() => {});
    const reservation = { label, reserved: true, readyPromise };
    this.processes.set(label, reservation);
    this.processOrder.push(label);
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        }),
        options.spawnTimeoutMs ?? 5_000,
        `${label} did not spawn`,
      );
    } catch (error) {
      stdoutLog.destroy();
      stderrLog.destroy();
      if (child.pid) {
        try {
          if (process.platform === 'win32') {
            child.kill('SIGKILL');
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch (signalError) {
          if (signalError.code !== 'ESRCH') {
            throw signalError;
          }
        }
      }
      if (this.processes.get(label) === reservation) {
        this.processes.delete(label);
        this.processOrder = this.processOrder.filter((candidate) => candidate !== label);
      }
      rejectReady(error);
      throw error;
    }

    const record = {
      label,
      child,
      stdoutPath,
      stderrPath,
      exitPromise,
      get exited() {
        return exited;
      },
      get result() {
        return exitResult;
      },
      get groupCleanupPromise() {
        return groupCleanupPromise;
      },
    };
    this.processes.set(label, record);
    resolveReady(record);

    return {
      label,
      pid: child.pid,
      stdoutPath,
      stderrPath,
      write: (value) => child.stdin.write(value),
      end: (value) => child.stdin.end(value),
      wait: (timeoutMs = this.defaultTimeoutMs) =>
        withTimeout(exitPromise, timeoutMs, `${label} did not exit within ${String(timeoutMs)}ms`),
      isRunning: () => !exited,
      stop: () => this.stopProcess(label),
    };
  }

  async stopProcess(label, { graceMs = 2_000 } = {}) {
    let record = this.processes.get(label);
    if (!record) {
      return null;
    }
    if (record.reserved) {
      try {
        record = await withTimeout(
          record.readyPromise,
          5_000,
          `process ${label} did not finish starting during cleanup`,
        );
      } catch {
        return null;
      }
    }
    if (record.exited) {
      await record.groupCleanupPromise;
      return record?.result ?? null;
    }
    this.#signalProcess(record, 'SIGTERM');
    let graceful = true;
    try {
      await withTimeout(record.exitPromise, graceMs, `${label} did not exit after SIGTERM`);
    } catch {
      graceful = false;
    }
    if (!graceful && !record.exited) {
      this.#signalProcess(record, 'SIGKILL');
      await withTimeout(record.exitPromise, 2_000, `${label} did not exit after SIGKILL`);
    }
    if (!record.exited) {
      throw new Error(`process ${label} did not exit`);
    }
    await record.groupCleanupPromise;
    return record.result;
  }

  async waitFor(description, predicate, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        if (
          await withTimeout(
            Promise.resolve().then(predicate),
            remainingMs,
            `${description} predicate exceeded its deadline`,
          )
        ) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    const suffix = lastError ? `: ${this.redact(lastError.message ?? lastError)}` : '';
    throw new Error(`timed out waiting for ${description}${suffix}`);
  }

  async waitForLog(label, pattern, options = {}) {
    const record = this.processes.get(label);
    if (!record) {
      throw new Error(`unknown process label: ${label}`);
    }
    const logPath = options.stream === 'stderr' ? record.stderrPath : record.stdoutPath;
    let match = null;
    await this.waitFor(
      `${label} log pattern`,
      () => {
        const contents = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
        match = contents.match(pattern);
        return match !== null;
      },
      options,
    );
    return match;
  }

  async requestHttp({
    url,
    method = 'GET',
    headers,
    body,
    timeoutMs = this.defaultTimeoutMs,
    expectStatus = 200,
    expectJson,
    expectText,
    maxBodyBytes = 1024 * 1024,
  }) {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBodyBytes) {
      throw new Error(`HTTP response exceeded ${String(maxBodyBytes)} bytes`);
    }
    const text = bytes.toString('utf8');
    const statuses = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
    assert.ok(
      statuses.includes(response.status),
      `expected HTTP ${statuses.join(' or ')}, received ${String(response.status)}`,
    );
    if (expectText !== undefined) {
      if (expectText instanceof RegExp) {
        assert.match(text, expectText);
      } else {
        assert.equal(text, expectText);
      }
    }
    let json = null;
    if (expectJson !== undefined) {
      json = JSON.parse(text);
      assertSubset(json, expectJson);
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  async openWebSocket(label, url, options = {}) {
    this.#assertAcceptingResources();
    const { default: WebSocket } = await import('ws');
    const rawSocket = options.protocols
      ? new WebSocket(url, options.protocols, { headers: options.headers })
      : new WebSocket(url, { headers: options.headers });
    const tracked = new TrackedWebSocket(this, safeName(label, 'socket'), rawSocket);
    this.sockets.add(tracked);
    try {
      await tracked.waitForOpen(options.timeoutMs ?? this.defaultTimeoutMs);
      return tracked;
    } catch (error) {
      rawSocket.terminate();
      this.sockets.delete(tracked);
      throw error;
    }
  }

  async acquireLease(resourceName, options = {}) {
    this.#assertAcceptingResources();
    if (this.leases.has(resourceName)) {
      throw new Error(`E2E resource is already leased by this run: ${resourceName}`);
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const digest = createHash('sha256').update(String(resourceName)).digest();
    const leasePort = 40_000 + (digest.readUInt16BE(0) % 20_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const server = createServer();
      try {
        await withTimeout(
          new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen({ host: '127.0.0.1', port: leasePort, exclusive: true }, resolve);
          }),
          Math.max(1, deadline - Date.now()),
          `lease bind timed out for ${resourceName}`,
        );
        const entry = { server, port: leasePort };
        const release = async () => {
          if (this.leases.get(resourceName) === entry) {
            await this.#closeLease(entry);
            this.leases.delete(resourceName);
          }
        };
        this.leases.set(resourceName, entry);
        return release;
      } catch (error) {
        if (server.listening) {
          await this.#closeLease({ server, port: leasePort });
        }
        if (error.code !== 'EADDRINUSE') {
          throw error;
        }
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `timed out acquiring E2E lease ${resourceName} at 127.0.0.1:${String(leasePort)}`,
    );
  }

  async cleanup() {
    if (this.cleanupPromise) {
      return await this.cleanupPromise;
    }
    this.cleanupStarted = true;
    this.cleanupPromise = this.#performCleanup();
    return await this.cleanupPromise;
  }

  async #performCleanup() {
    const errors = [];
    for (const socket of [...this.sockets].reverse()) {
      try {
        await socket.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.sockets.clear();
    for (const label of [...this.processOrder].reverse()) {
      try {
        await this.stopProcess(label);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const [resourceName, entry] of this.leases) {
      try {
        await this.#closeLease(entry);
        this.leases.delete(resourceName);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.evidenceOutputPath) {
      try {
        mkdirSync(path.dirname(this.evidenceOutputPath), { recursive: true });
      } catch (error) {
        errors.push(error);
      }
    }
    const emitTerminalRecord = () => {
      this.emit({
        event: 'run',
        status: errors.length === 0 ? this.runOutcome : 'cleanup-fail',
        ...(this.runError ? { error: this.runError } : {}),
        ...(errors.length > 0
          ? { cleanupError: this.redact(errors.map((error) => error.message).join('; ')) }
          : {}),
      });
    };
    emitTerminalRecord();
    if (this.evidenceOutputPath) {
      try {
        copyFileSync(this.evidencePath, this.evidenceOutputPath);
        chmodSync(this.evidenceOutputPath, 0o600);
      } catch (error) {
        errors.push(error);
        emitTerminalRecord();
      }
    }
    if (!this.keepArtifacts) {
      try {
        this.#removeRoot();
      } catch (error) {
        errors.push(error);
        emitTerminalRecord();
        if (this.evidenceOutputPath) {
          try {
            copyFileSync(this.evidencePath, this.evidenceOutputPath);
            chmodSync(this.evidenceOutputPath, 0o600);
          } catch {
            // The original cleanup errors below retain both failure causes and the run root.
          }
        }
      }
    } else {
      writeFileSync(
        path.join(this.root, OWNER_MARKER),
        JSON.stringify({
          kind: OWNER_KIND,
          pid: process.pid,
          runId: this.runId,
          preserve: true,
        }),
        { mode: 0o600 },
      );
    }
    if (errors.length > 0) {
      const retained = existsSync(this.root) ? `; artifacts retained at ${this.root}` : '';
      throw new Error(
        `E2E cleanup failed: ${errors.map((error) => error.message).join('; ')}${retained}`,
      );
    }
  }

  #assertAcceptingResources() {
    if (this.cleanupStarted) {
      throw new Error('E2E run is cleaning up and cannot accept new work');
    }
  }

  #nextProcessLabel(prefix) {
    this.processSequence += 1;
    return `${safeName(prefix, 'process')}-${String(this.processSequence)}`;
  }

  #redactStructured(value) {
    if (typeof value === 'string') {
      return this.redact(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.#redactStructured(entry));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          this.redact(key),
          this.#redactStructured(entry),
        ]),
      );
    }
    return value;
  }

  #setOutcome(outcome, error = null) {
    if (this.cleanupStarted) {
      throw new Error('cannot change E2E outcome after cleanup starts');
    }
    if (outcome === 'pass' && (this.failedPhases.size > 0 || this.failedAssertions.length > 0)) {
      throw new Error('cannot mark an E2E run passed after a phase or assertion failure');
    }
    this.runOutcome = outcome;
    this.runError = error ? this.redact(error instanceof Error ? error.message : error) : null;
  }

  async #drainProcessGroup(processGroupId) {
    if (!processGroupIsAlive(processGroupId)) {
      return;
    }
    try {
      process.kill(-processGroupId, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
      return;
    }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && processGroupIsAlive(processGroupId)) {
      await sleep(25);
    }
    if (!processGroupIsAlive(processGroupId)) {
      return;
    }
    try {
      process.kill(-processGroupId, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
      return;
    }
    const forcedDeadline = Date.now() + 1_000;
    while (Date.now() < forcedDeadline && processGroupIsAlive(processGroupId)) {
      await sleep(25);
    }
    if (processGroupIsAlive(processGroupId)) {
      throw new Error(`process group ${String(processGroupId)} did not exit`);
    }
  }

  async #closeLease(entry) {
    if (!entry.server.listening) {
      return;
    }
    await withTimeout(
      new Promise((resolve, reject) => {
        entry.server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
      1_000,
      `lease port ${String(entry.port)} did not close`,
    );
  }

  #signalProcess(record, signal) {
    try {
      if (process.platform === 'win32') {
        record.child.kill(signal);
      } else {
        process.kill(-record.child.pid, signal);
      }
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  #removeRoot() {
    const parent = realpathSync(path.dirname(this.root));
    if (parent !== this.tempBase || !path.basename(this.root).startsWith(`${this.name}.`)) {
      throw new Error(`refusing to remove unexpected E2E root: ${this.root}`);
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function createHarness(options) {
  return new E2EHarness(options);
}

export { assert, assertSubset };
