import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { repoRoot } from './paths.ts';
import {
  createDefaultScenario,
  scenarioThreadId,
  type Scenario,
  type ScenarioOverrides,
} from './scenario.ts';

const START_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;

export interface RealBridgeOptions {
  readonly scenario?: Scenario | ScenarioOverrides;
}

export interface StreamAssistantTurnOptions {
  readonly threadId: string;
  readonly messageId?: string;
  readonly chunks: readonly string[];
  readonly delayMs?: number;
  readonly succeed?: boolean;
  readonly whileRunning?: () => Promise<void>;
}

export interface RealBridge {
  readonly url: string;
  readonly token: string;
  readonly scenario: Scenario;
  waitForConnection(timeoutMs?: number): Promise<void>;
  streamAssistantTurn(options: StreamAssistantTurnOptions): Promise<void>;
  close(): Promise<void>;
}

export async function startRealBridge(options: RealBridgeOptions = {}): Promise<RealBridge> {
  const scenario = normalizeScenario(options.scenario);
  const root = await mkdtemp(path.join(tmpdir(), 'dappercode-real-bridge-e2e-'));
  let child: ChildProcess | null = null;
  let owner: ChildProcess | null = null;
  try {
    const runtimeDir = path.join(root, 'runtime');
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    await Promise.all([mkdir(runtimeDir), mkdir(dataDir), mkdir(workspaceDir)]);

    const executableSuffix = process.platform === 'win32' ? '.exe' : '';
    const targetDir = process.env['DAPPERCODE_E2E_CARGO_TARGET_DIR'];
    if (!targetDir) {
      throw new Error('DAPPERCODE_E2E_CARGO_TARGET_DIR was not set by Playwright global setup.');
    }
    const sourceBridge = path.join(targetDir, 'debug', `dappercode-bridge${executableSuffix}`);
    const sourceAgent = path.join(targetDir, 'debug', `dappercode-e2e-agent${executableSuffix}`);
    const bridgeExecutable = path.join(runtimeDir, `dappercode-bridge${executableSuffix}`);
    const agentExecutable = path.join(runtimeDir, `dappercode-e2e-agent${executableSuffix}`);
    await Promise.all([
      copyFile(sourceBridge, bridgeExecutable),
      copyFile(sourceAgent, agentExecutable),
    ]);
    if (process.platform !== 'win32') {
      await Promise.all([chmod(bridgeExecutable, 0o700), chmod(agentExecutable, 0o700)]);
    }

    const scenarioPath = path.join(dataDir, 'scenario.json');
    const controlPath = path.join(dataDir, 'prompt-control.json');
    const manifestPath = path.join(dataDir, 'agents.json');
    const runtimeScenario = {
      ...scenario,
      chats: scenario.chats.map((chat) => ({ ...chat, cwd: workspaceDir })),
    };
    await writeFile(scenarioPath, JSON.stringify(runtimeScenario), { mode: 0o600 });
    await writeFile(
      manifestPath,
      JSON.stringify({
        preferredAgentId: scenario.agentId,
        agents: [
          {
            enabled: true,
            displayName: scenario.agentDisplayName,
            icon: null,
            agentId: scenario.agentId,
            executable: agentExecutable,
            argv: [],
            environment: {
              DAPPERCODE_E2E_SCENARIO_PATH: { kind: 'literal', value: scenarioPath },
              DAPPERCODE_E2E_CONTROL_PATH: { kind: 'literal', value: controlPath },
            },
            resolvedVersion: 'e2e',
            provenance: 'typed deterministic ACP fixture',
            verifiedDigest: await sha256(agentExecutable),
            integrity: { kind: 'executable' },
          },
        ],
      }),
      { mode: 0o600 },
    );

    const token = `e2e-${randomUUID()}`;
    owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      stdio: 'ignore',
    });
    if (!owner.pid) {
      throw new Error('Failed to start the isolated bridge owner process.');
    }
    const ownerProcess = owner;

    child = spawn(bridgeExecutable, [], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: '0',
        BRIDGE_PREVIEW_HOST: '127.0.0.1',
        BRIDGE_PREVIEW_PORT: '0',
        BRIDGE_DISABLE_BROWSER_PREVIEW: 'true',
        BRIDGE_WORKDIR: workspaceDir,
        BRIDGE_STATE_DIR: path.join(dataDir, 'state'),
        BRIDGE_ATTACHMENTS_DIR: path.join(dataDir, 'attachments'),
        ACP_AGENT_MANIFEST: manifestPath,
        ACP_AGENT_ROOTS: runtimeDir,
        ACP_INITIALIZE_TIMEOUT_MS: '15000',
        BRIDGE_AUTH_TOKEN: token,
        BRIDGE_ALLOW_QUERY_TOKEN_AUTH: 'true',
        BRIDGE_ALLOW_OUTSIDE_ROOT_CWD: 'false',
        BRIDGE_SHOW_PAIRING_QR: 'false',
        BRIDGE_OWNER_PID: String(ownerProcess.pid),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bridgeChild = child;
    const { url, output } = await waitForBridgeAddress(bridgeChild);
    const bootstrapSocket = await openSocket(url, token, START_TIMEOUT_MS);
    try {
      await sendRpc(bootstrapSocket, 'thread/list', { limit: scenario.chats.length });
      for (const chat of scenario.chats) {
        await sendRpc(bootstrapSocket, 'thread/read', {
          threadId: scenarioThreadId(chat.id, scenario.agentId),
        });
      }
    } finally {
      await closeSocket(bootstrapSocket);
    }
    let closed = false;

    return {
      url,
      token,
      scenario,
      async waitForConnection(timeoutMs = START_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const response = await fetch(`${url}/status`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Connection: 'close',
            },
          });
          if (response.ok) {
            const health = asRecord(await response.json());
            if (typeof health?.['connectedClients'] === 'number' && health.connectedClients > 0) {
              return;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(
          'Timed out waiting for the mobile app to connect to the production bridge.',
        );
      },
      async streamAssistantTurn(streamOptions) {
        const messageId = streamOptions.messageId ?? `e2e-message-${randomUUID()}`;
        const holdingPath = replaceExtension(controlPath, 'holding');
        const releasePath = replaceExtension(controlPath, 'release');
        await Promise.all([
          rm(holdingPath, { force: true }),
          rm(releasePath, { force: true }),
          writeFile(
            controlPath,
            JSON.stringify({
              chunks: streamOptions.chunks,
              delayMs: streamOptions.delayMs ?? 0,
              succeed: streamOptions.succeed ?? true,
              hold: Boolean(streamOptions.whileRunning),
              messageId,
            }),
            { mode: 0o600 },
          ),
        ]);
        const socket = await openSocket(url, token, RPC_TIMEOUT_MS);
        try {
          await sendRpc(socket, 'thread/resume', {
            threadId: streamOptions.threadId,
            cwd: workspaceDir,
            approvalPolicy: 'untrusted',
          });
          const terminal = waitForTerminalRun(
            socket,
            streamOptions.threadId,
            streamOptions.succeed ?? true,
            RPC_TIMEOUT_MS,
          );
          try {
            await sendRpc(socket, 'turn/start', {
              threadId: streamOptions.threadId,
              input: [{ type: 'text', text: 'E2E stream trigger', text_elements: [] }],
              cwd: workspaceDir,
              approvalPolicy: 'untrusted',
            });
            if (streamOptions.whileRunning) {
              await waitForFile(holdingPath, RPC_TIMEOUT_MS);
              await streamOptions.whileRunning();
              await writeFile(releasePath, 'release', { mode: 0o600 });
            }
            await terminal.promise;
          } finally {
            terminal.cancel();
          }
        } finally {
          await closeSocket(socket);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        const exitedBeforeCleanup =
          bridgeChild.exitCode !== null || bridgeChild.signalCode !== null;
        const ownerForced = await stopChild(ownerProcess);
        const forced = await stopChild(bridgeChild);
        await rm(root, { recursive: true, force: true });
        if (exitedBeforeCleanup || ownerForced || forced) {
          throw new Error(
            `Production bridge ${
              forced
                ? 'required SIGKILL during cleanup'
                : ownerForced
                  ? 'owner process required SIGKILL during cleanup'
                  : `exited unexpectedly (${formatExit(bridgeChild)})`
            }.\n${output.join('')}`,
          );
        }
      },
    };
  } catch (error) {
    if (owner) await stopChild(owner);
    if (child) await stopChild(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function normalizeScenario(input: Scenario | ScenarioOverrides | undefined): Scenario {
  if (isScenario(input)) {
    return input;
  }
  return createDefaultScenario(input);
}

function isScenario(input: Scenario | ScenarioOverrides | undefined): input is Scenario {
  return Boolean(
    input &&
    Array.isArray(input.chats) &&
    typeof input.agentId === 'string' &&
    typeof input.agentDisplayName === 'string',
  );
}

async function sha256(file: string): Promise<string> {
  return `sha256:${createHash('sha256')
    .update(await readFile(file))
    .digest('hex')}`;
}

function waitForBridgeAddress(
  child: ChildProcess,
): Promise<{ readonly url: string; readonly output: string[] }> {
  const output: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out starting production bridge.\n${output.join('')}`));
    }, START_TIMEOUT_MS);
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      const match = output.join('').match(/rust-bridge listening on (127\.0\.0\.1:\d+)/u);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ url: `http://${match[1]}`, output });
      }
    };
    if (!child.stdout || !child.stderr) {
      reject(new Error('Production bridge did not expose stdout and stderr.'));
      return;
    }
    child.stdout.on('data', read);
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Production bridge exited before listening (${String(code)}).\n${output.join('')}`,
        ),
      );
    });
  });
}

function openSocket(url: string, token: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${url.replace(/^http/u, 'ws')}/rpc?token=${encodeURIComponent(token)}`,
    );
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out connecting to the production bridge.'));
    }, timeoutMs);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sendRpc(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for production bridge RPC "${method}".`));
    }, RPC_TIMEOUT_MS);
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame['id'] !== id) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (frame['error']) {
        reject(
          new Error(`Production bridge RPC "${method}" failed: ${JSON.stringify(frame['error'])}`),
        );
      } else {
        resolve(frame['result']);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function waitForTerminalRun(
  socket: WebSocket,
  threadId: string,
  expectSuccess: boolean,
  timeoutMs: number,
): { readonly promise: Promise<void>; cancel(): void } {
  let settled = false;
  let timer: NodeJS.Timeout;
  const onMessage = (raw: WebSocket.RawData) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const params = asRecord(frame['params']);
    const event = asRecord(params?.['event']);
    if (
      frame['method'] === 'bridge/agui.event' &&
      params?.['threadId'] === threadId &&
      (event?.['type'] === 'RUN_FINISHED' || event?.['type'] === 'RUN_ERROR')
    ) {
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      const succeeded = event['type'] === 'RUN_FINISHED';
      if (succeeded === expectSuccess) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            `Expected the production bridge run to ${expectSuccess ? 'succeed' : 'fail'}, ` +
              `but it emitted ${String(event['type'])}.`,
          ),
        );
      }
    }
  };
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    timer = setTimeout(() => {
      settled = true;
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for the production bridge to finish the streamed run.'));
    }, timeoutMs);
    socket.on('message', onMessage);
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolvePromise();
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ACP fixture state at ${file}.`);
}

async function stopChild(child: ChildProcess): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  let settled = false;
  const closed = new Promise<void>((resolve) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', settle);
    child.once('close', settle);
    child.once('error', settle);
  });
  child.kill('SIGTERM');
  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (!settled) {
    child.kill('SIGKILL');
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Production bridge did not terminate after SIGKILL.')),
          SHUTDOWN_TIMEOUT_MS,
        ),
      ),
    ]);
    return true;
  }
  return false;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close(1000, 'E2E client finished');
  await Promise.race([
    closed,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        resolve();
      }, 1_000),
    ),
  ]);
  await closed;
}

function replaceExtension(file: string, extension: string): string {
  return `${file.slice(0, file.lastIndexOf('.'))}.${extension}`;
}

function formatExit(child: ChildProcess): string {
  if (child.exitCode !== null) return `exit ${String(child.exitCode)}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return 'unknown process state';
}
