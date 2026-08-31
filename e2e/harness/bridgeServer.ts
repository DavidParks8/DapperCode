import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

import { declaredMethods, declaredNotifications } from './contract.ts';
import {
  FIXED_NOW_ISO,
  PROTOCOL_VERSION,
  RPC_ERROR,
  RpcError,
  STREAM_ID,
  isRecord,
  notFound,
  readRecordParam,
  readString,
  readStringParam,
  type NotificationFrame,
  type RpcRequestFrame,
} from './protocol.ts';
import {
  buildCapabilities,
  buildWorkspaceList,
  createDefaultScenario,
  emptyQueueState,
  toRawThread,
  toRawThreadSummary,
  type Scenario,
  type ScenarioChat,
  type ScenarioOverrides,
} from './scenario.ts';
import {
  conforms,
  type BridgeThreadCreateResponse,
  type BridgeThreadSchedulesState,
} from './shapes.ts';

export interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
  readonly at: number;
}

export type RpcHandler = (params: unknown, bridge: HarnessBridge) => unknown | Promise<unknown>;

/**
 * A call the harness could not answer the way the real bridge would.
 *
 * `undeclared` means the app asked for a method the shared contract does not list at all, which is
 * a contract bug. `unhandled` means the contract lists it but the harness has no handler, which is
 * harness drift: the real bridge would have answered.
 */
export interface ContractDrift {
  readonly method: string;
  readonly reason: 'undeclared' | 'unhandled';
}

function assertDeclaredNotification(method: string): void {
  if (!declaredNotifications.has(method)) {
    throw new Error(
      `The bridge contract declares no notification "${method}". Add it to ` +
        `contracts/bridge-rpc/v2/manifest.json once the real bridge emits it.`,
    );
  }
}

export interface HarnessBridgeOptions {
  readonly scenario?: Scenario | ScenarioOverrides;
  /** Overrides merged over the built-in handlers, for per-spec behaviour such as forced errors. */
  readonly handlers?: Readonly<Record<string, RpcHandler>>;
}

/**
 * A fake bridge that speaks the real mobile wire protocol.
 *
 * Every instance binds port 0 and owns all of its state in memory, so any number of workers — and
 * any number of simultaneous test runs — can each have their own bridge with no shared ports,
 * files, or fixtures to collide over.
 */
export interface HarnessBridge {
  readonly url: string;
  readonly token: string;
  readonly scenario: Scenario;
  /** Every RPC the app has issued, in order. Useful for asserting a flow actually hit the wire. */
  readonly requests: readonly RecordedRequest[];
  /** Calls the harness could not serve faithfully. Asserted empty after every test. */
  readonly contractDrift: readonly ContractDrift[];
  /** Every RPC method this harness can answer. */
  readonly handlerMethods: readonly string[];

  /** Replaces or adds a handler for a single method. */
  setHandler(method: string, handler: RpcHandler): void;
  /** Waits until the app has issued the given method, returning the recorded call. */
  waitForRequest(method: string, timeoutMs?: number): Promise<RecordedRequest>;
  /** Emits a numbered notification with a contiguous event id. */
  emit(method: string, params: unknown): void;
  /** Emits a notification without an event id, bypassing ordering. */
  emitUnnumbered(method: string, params: unknown): void;
  /** Waits for at least one client to be connected. */
  waitForConnection(timeoutMs?: number): Promise<void>;
  /** Streams a complete assistant turn as AG-UI events. */
  streamAssistantTurn(options: StreamAssistantTurnOptions): Promise<void>;
  /** Mutates scenario chat data so a later `thread/read` reflects new state. */
  upsertChat(chat: ScenarioChat): void;
  close(): Promise<void>;
}

export interface StreamAssistantTurnOptions {
  readonly threadId: string;
  readonly turnId?: string;
  readonly messageId?: string;
  /** Text is emitted as separate deltas so the UI genuinely streams. */
  readonly chunks: readonly string[];
  /** Delay between deltas, letting a spec observe intermediate layout. */
  readonly delayMs?: number;
  /** When false the run ends with RUN_ERROR instead of RUN_FINISHED. */
  readonly succeed?: boolean;
  readonly errorMessage?: string;
  readonly errorCode?: string;
  /** Appends the finished assistant message to the scenario transcript. */
  readonly persist?: boolean;
  /**
   * Runs after the deltas are emitted but before the turn terminates, holding the run open until
   * it resolves.
   *
   * Without this, a spec that wants to observe "running" state has to race the stream with a
   * timing guess, which fails the moment the machine is busy. Holding the run makes those
   * observations deterministic no matter how loaded the host is.
   */
  readonly whileRunning?: () => Promise<void>;
}

export async function startHarnessBridge(
  options: HarnessBridgeOptions = {},
): Promise<HarnessBridge> {
  const scenario = normalizeScenario(options.scenario);
  const token = `harness-${randomUUID()}`;
  const chats = new Map(scenario.chats.map((chat) => [chat.id, chat] as const));
  const chatOrder = scenario.chats.map((chat) => chat.id);
  const handlers = new Map<string, RpcHandler>();
  const requests: RecordedRequest[] = [];
  const contractDrift: ContractDrift[] = [];
  const sockets = new Set<WebSocket>();
  const inFlight = new Set<Promise<void>>();
  const requestWaiters: { method: string; resolve: (value: RecordedRequest) => void }[] = [];
  const connectionWaiters: (() => void)[] = [];

  let eventId = 0;
  let turnCounter = 0;

  const httpServer = createServer((request, response) => {
    handleHttpRequest(request, response, token);
  });

  const wsServer = new WebSocketServer({ noServer: true });

  const bridge: HarnessBridge = {
    get url() {
      const address = httpServer.address() as AddressInfo;
      return `http://127.0.0.1:${String(address.port)}`;
    },
    token,
    scenario,
    requests,
    contractDrift,
    get handlerMethods() {
      return [...handlers.keys()].sort();
    },
    setHandler(method, handler) {
      // A handler for a method the real bridge does not expose would make the harness answer
      // something production never answers, which is drift the specs could never notice.
      if (!declaredMethods.has(method)) {
        throw new Error(
          `The bridge contract declares no RPC method "${method}". Add it to ` +
            `contracts/bridge-rpc/v2/manifest.json once the real bridge implements it.`,
        );
      }
      handlers.set(method, handler);
    },
    waitForRequest(method, timeoutMs = 10_000) {
      const existing = requests.find((entry) => entry.method === method);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<RecordedRequest>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = requestWaiters.findIndex((waiter) => waiter.resolve === wrapped);
          if (index >= 0) {
            requestWaiters.splice(index, 1);
          }
          reject(
            new Error(
              `Timed out waiting for RPC "${method}". Observed: ${
                requests.map((entry) => entry.method).join(', ') || '(none)'
              }`,
            ),
          );
        }, timeoutMs);
        const wrapped = (value: RecordedRequest) => {
          clearTimeout(timer);
          resolve(value);
        };
        requestWaiters.push({ method, resolve: wrapped });
      });
    },
    emit(method, params) {
      assertDeclaredNotification(method);
      eventId += 1;
      broadcast({
        method,
        protocolVersion: PROTOCOL_VERSION,
        streamId: STREAM_ID,
        eventId,
        params,
      });
    },
    emitUnnumbered(method, params) {
      assertDeclaredNotification(method);
      broadcast({ method, protocolVersion: PROTOCOL_VERSION, streamId: STREAM_ID, params });
    },
    waitForConnection(timeoutMs = 15_000) {
      if (sockets.size > 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for the app to open a bridge WebSocket.'));
        }, timeoutMs);
        connectionWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    async streamAssistantTurn(streamOptions) {
      await streamAssistantTurn(bridge, streamOptions, (chat) => {
        bridge.upsertChat(chat);
      });
    },
    upsertChat(chat) {
      if (!chats.has(chat.id)) {
        chatOrder.push(chat.id);
      }
      chats.set(chat.id, chat);
    },
    async close() {
      // Let requests already being handled settle before tearing anything down, so the drift the
      // fixture is about to read is complete rather than a snapshot of a moving target.
      await Promise.allSettled([...inFlight]);
      for (const socket of sockets) {
        socket.terminate();
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        wsServer.close(() => {
          resolve();
        });
      });
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => {
          resolve();
        });
      });
    },
  };

  registerDefaultHandlers(handlers, {
    scenario,
    chats,
    chatOrder,
    nextTurnId: () => {
      turnCounter += 1;
      return `turn-${String(turnCounter)}`;
    },
    currentEventId: () => eventId,
  });

  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    bridge.setHandler(method, handler);
  }

  assertHandlersAreDeclared(handlers);

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/rpc') {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (client) => {
      attachSocket(client);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  return bridge;

  function attachSocket(socket: WebSocket): void {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('message', (data) => {
      // Tracked so close() can await settlement: a request still in flight during teardown would
      // otherwise record drift after the fixture had already inspected it.
      const pending = handleFrame(socket, String(data)).finally(() => {
        inFlight.delete(pending);
      });
      inFlight.add(pending);
    });

    // The real bridge speaks first. This frame is what teaches the client the stream identity and
    // protocol version, so it must arrive before anything numbered. It goes through the same
    // declaration guard as every other notification rather than bypassing it via send().
    assertDeclaredNotification('bridge/connection/state');
    send(socket, {
      method: 'bridge/connection/state',
      protocolVersion: PROTOCOL_VERSION,
      streamId: STREAM_ID,
      params: { status: 'connected', at: FIXED_NOW_ISO },
    });

    for (const waiter of connectionWaiters.splice(0)) {
      waiter();
    }
  }

  async function handleFrame(socket: WebSocket, raw: string): Promise<void> {
    let frame: RpcRequestFrame;
    try {
      frame = JSON.parse(raw) as RpcRequestFrame;
    } catch {
      return;
    }
    const { id, method } = frame;
    if (id === undefined || typeof method !== 'string') {
      return;
    }

    const record: RecordedRequest = { method, params: frame.params, at: Date.now() };
    requests.push(record);
    for (let index = requestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = requestWaiters[index];
      if (waiter && waiter.method === method) {
        requestWaiters.splice(index, 1);
        waiter.resolve(record);
      }
    }

    const handler = handlers.get(method);
    if (!handler) {
      // Recorded rather than ignored: the app calling something the harness does not model is
      // exactly how the harness silently stops resembling the real bridge.
      contractDrift.push({
        method,
        reason: declaredMethods.has(method) ? 'unhandled' : 'undeclared',
      });
      socket.send(
        JSON.stringify({
          id,
          error: { code: RPC_ERROR.methodNotFound, message: `No harness handler for ${method}` },
        }),
      );
      return;
    }

    try {
      const result = await handler(frame.params, bridge);
      socket.send(JSON.stringify({ id, result: result ?? null }));
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError(RPC_ERROR.serverError, error instanceof Error ? error.message : 'failed');
      socket.send(
        JSON.stringify({
          id,
          error: { code: rpcError.code, message: rpcError.message, data: rpcError.data },
        }),
      );
    }
  }

  function broadcast(frame: NotificationFrame): void {
    const payload = JSON.stringify(frame);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  function send(socket: WebSocket, frame: NotificationFrame): void {
    socket.send(JSON.stringify(frame));
  }
}

interface HandlerContext {
  readonly scenario: Scenario;
  readonly chats: Map<string, ScenarioChat>;
  readonly chatOrder: string[];
  readonly nextTurnId: () => string;
  readonly currentEventId: () => number;
}

/**
 * Fails if the harness registered a method the shared bridge contract does not declare.
 *
 * The built-in handlers populate the map directly rather than going through `setHandler`, so they
 * are validated here in one place. A typo or an invented method surfaces the moment any bridge
 * starts, instead of quietly teaching the specs to rely on behaviour production does not have.
 */
function assertHandlersAreDeclared(handlers: ReadonlyMap<string, RpcHandler>): void {
  const undeclared = [...handlers.keys()].filter((method) => !declaredMethods.has(method)).sort();
  if (undeclared.length > 0) {
    throw new Error(
      `The harness bridge registered ${String(undeclared.length)} RPC method(s) the bridge ` +
        `contract does not declare: ${undeclared.join(', ')}. Add them to ` +
        `contracts/bridge-rpc/v2/manifest.json once the real bridge implements them.`,
    );
  }
}

function registerDefaultHandlers(handlers: Map<string, RpcHandler>, context: HandlerContext): void {
  const orderedChats = () =>
    context.chatOrder
      .map((id) => context.chats.get(id))
      .filter((chat): chat is ScenarioChat => chat !== undefined);

  handlers.set('bridge/health/read', () => ({ status: 'ok' }));
  handlers.set('bridge/capabilities/read', () => buildCapabilities(context.scenario));
  handlers.set('bridge/workspaces/list', () => buildWorkspaceList(context.scenario));
  handlers.set('bridge/approvals/list', () => []);
  handlers.set('bridge/userInput/list', () => []);
  handlers.set('thread/loaded/list', () => ({ data: [] }));

  handlers.set('thread/list', () => ({
    data: orderedChats().map(toRawThreadSummary),
    nextCursor: null,
    backwardsCursor: null,
  }));

  // The drawer prefers a streaming list. Returning `started: false` would make the client fall back
  // to `thread/list`, but streaming is the real production path so the harness implements it.
  handlers.set('bridge/thread/list/stream/start', (params, bridge) => {
    const streamId = readStringParam(params, 'streamId');
    if (!streamId) {
      return { streamId: null, started: false };
    }
    // Deferred so the RPC result lands before the first batch notification.
    setImmediate(() => {
      bridge.emit('bridge/thread/list/stream/batch', {
        streamId,
        limit: orderedChats().length,
        done: true,
        data: orderedChats().map(toRawThreadSummary),
      });
    });
    return { streamId, started: true };
  });

  handlers.set('bridge/thread/list/stream/cancel', () => ({ ok: true }));

  const resolveChat = (ctx: typeof context, params: unknown): ScenarioChat => {
    const threadId = readStringParam(params, 'threadId');
    const chat = threadId ? ctx.chats.get(threadId) : undefined;
    if (!chat) {
      throw notFound(`Unknown thread ${String(threadId)}`);
    }
    return chat;
  };

  handlers.set('thread/read', (params) => {
    const threadId = readStringParam(params, 'threadId');
    const index = threadId ? context.chatOrder.indexOf(threadId) : -1;
    const chat = threadId ? context.chats.get(threadId) : undefined;
    if (!chat) {
      throw notFound(`Unknown thread ${String(threadId)}`);
    }
    return { thread: toRawThread(chat, index < 0 ? 0 : index) };
  });

  handlers.set('thread/snapshot/page', () => ({
    entries: [],
    beforeCursor: null,
    afterCursor: null,
    hasMoreBefore: false,
    hasMoreAfter: false,
    unavailableCount: 0,
    earliestAvailableSequence: null,
    latestAvailableSequence: null,
    revision: null,
  }));

  handlers.set('bridge/thread/queue/read', (params) =>
    emptyQueueState(readStringParam(params, 'threadId') ?? 'unknown'),
  );
  handlers.set('bridge/thread/queue/cancel', (params) =>
    emptyQueueState(readStringParam(params, 'threadId') ?? 'unknown'),
  );
  handlers.set('bridge/thread/schedules/read', (params) =>
    conforms<BridgeThreadSchedulesState>({
      threadId: readStringParam(params, 'threadId') ?? 'unknown',
      schedules: [],
    }),
  );

  handlers.set('thread/resume', () => ({ model: 'harness-model', effort: 'medium' }));
  handlers.set('thread/approvalPolicy/set', () => ({ ok: true }));
  // The client throws unless these echo the updated thread back, so `{ ok: true }` would be a
  // shape the real bridge never sends.
  handlers.set('thread/config/set', (params) => ({
    thread: toRawThread(resolveChat(context, params), 0),
  }));
  handlers.set('thread/name/update', (params) => {
    const chat = resolveChat(context, params);
    const title = readStringParam(params, 'title') ?? chat.title;
    const renamed: ScenarioChat = { ...chat, title };
    context.chats.set(renamed.id, renamed);
    return { thread: toRawThread(renamed, 0) };
  });
  handlers.set('thread/delete', () => ({ ok: true }));

  handlers.set('turn/start', () => ({ turn: { id: context.nextTurnId() } }));
  handlers.set('turn/interrupt', () => ({}));

  handlers.set('bridge/thread/queue/send', (params) => {
    const threadId = readStringParam(params, 'threadId') ?? 'unknown';
    return {
      submissionId: readStringParam(params, 'submissionId'),
      disposition: 'sent',
      turnId: context.nextTurnId(),
      queue: emptyQueueState(threadId),
    };
  });

  handlers.set('bridge/thread/create', (params) => {
    const threadId = `thread-${String(context.chatOrder.length + 1)}`;
    // The bridge nests the request under `threadStart` and echoes the submission id back.
    const threadStart = readRecordParam(params, 'threadStart');
    const cwd = readString(threadStart?.['cwd']) ?? undefined;
    const chat: ScenarioChat = { id: threadId, title: 'New chat', messages: [], cwd };
    context.chats.set(threadId, chat);
    context.chatOrder.unshift(threadId);
    return conforms<BridgeThreadCreateResponse>({
      submissionId: readStringParam(params, 'submissionId') ?? '',
      thread: toRawThread(chat, 0),
    });
  });

  handlers.set('model/list', () => ({
    data: [
      {
        id: 'harness-model',
        displayName: 'Harness Model',
        providerId: 'harness',
        providerName: 'Harness',
        contextWindow: 200_000,
      },
    ],
  }));

  handlers.set('bridge/approvals/resolve', (params) => ({
    ok: true,
    approval: null,
    decision: readStringParam(params, 'decision'),
    resolutionId: readStringParam(params, 'resolutionId'),
  }));
  handlers.set('bridge/userInput/resolve', () => ({ ok: true, request: null }));

  /**
   * The harness always emits contiguous event ids, so nothing is ever genuinely missed. Reporting
   * the current cursor as `latestEventId` satisfies the client's replay integrity check and ends
   * recovery immediately instead of leaving buffered events undrained.
   */
  handlers.set('bridge/events/replay', () => ({
    protocolVersion: PROTOCOL_VERSION,
    streamId: STREAM_ID,
    events: [],
    hasMore: false,
    earliestEventId: 1,
    latestEventId: context.currentEventId(),
  }));
}

async function streamAssistantTurn(
  bridge: HarnessBridge,
  options: StreamAssistantTurnOptions,
  persistChat: (chat: ScenarioChat) => void,
): Promise<void> {
  const turnId = options.turnId ?? 'turn-1';
  const messageId = options.messageId ?? `${turnId}-message`;
  const runId = `${options.threadId}::turn::${turnId}`;
  const succeed = options.succeed ?? true;
  const delayMs = options.delayMs ?? 0;

  const emitAgUi = (event: Record<string, unknown>) => {
    bridge.emit('bridge/agui.event', {
      threadId: options.threadId,
      runId,
      sourceTurnId: turnId,
      event,
    });
  };

  emitAgUi({ type: 'RUN_STARTED', threadId: options.threadId, runId, timestamp: Date.now() });
  emitAgUi({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant', timestamp: Date.now() });

  for (const chunk of options.chunks) {
    if (delayMs > 0) {
      await delay(delayMs);
    }
    emitAgUi({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: chunk, timestamp: Date.now() });
  }

  if (options.whileRunning) {
    await options.whileRunning();
  }

  emitAgUi({ type: 'TEXT_MESSAGE_END', messageId, timestamp: Date.now() });

  if (options.persist ?? true) {
    const existing = bridge.scenario.chats.find((chat) => chat.id === options.threadId);
    if (existing) {
      persistChat({
        ...existing,
        status: succeed ? 'complete' : 'error',
        messages: [
          ...(existing.messages ?? []),
          { id: messageId, role: 'assistant', text: options.chunks.join('') },
        ],
      });
    }
  }

  if (succeed) {
    emitAgUi({ type: 'RUN_FINISHED', threadId: options.threadId, runId, timestamp: Date.now() });
    return;
  }
  emitAgUi({
    type: 'RUN_ERROR',
    message: options.errorMessage ?? 'harness run failed',
    code: options.errorCode ?? 'acp_run_failed',
    timestamp: Date.now(),
  });
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    respondJson(response, 200, { status: 'ok', protocolVersion: PROTOCOL_VERSION });
    return;
  }

  if (url.pathname === '/attachments' && request.method === 'POST') {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    if (!authorized) {
      respondJson(response, 401, { error: 'unauthorized' });
      return;
    }
    // The body is drained but not parsed: layout specs only need a well-formed success response.
    request.resume();
    request.on('end', () => {
      respondJson(response, 200, {
        path: '/workspace/dappercode/.attachments/harness-upload.png',
        fileName: 'harness-upload.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        kind: 'image',
      });
    });
    return;
  }

  respondJson(response, 404, { error: 'not found' });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  response.end(payload);
}

function normalizeScenario(input: Scenario | ScenarioOverrides | undefined): Scenario {
  if (input && 'chats' in input && 'agentId' in input && 'workspaces' in input) {
    return input as Scenario;
  }
  return createDefaultScenario(input ?? {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function closeAllSockets(server: Server): void {
  server.closeAllConnections();
}
