/**
 * Wire protocol constants and envelope types for the harness bridge.
 *
 * The mobile client does not speak strict JSON-RPC 2.0: it never sends a `jsonrpc` field and never
 * requires one back. Frames are correlated purely by echoing the request `id`. See
 * `apps/mobile/src/bridge/ws/socketTransportLayer.ts` for the client side of this contract.
 */

/** Must match `HostBridgeWsClientCore.PROTOCOL_VERSION`. Any other value fails the client closed. */
export const PROTOCOL_VERSION = 2;

/**
 * Identity of the harness event stream. It must stay constant for the lifetime of a bridge:
 * changing it makes the client discard its delivery epoch and demand a full resync.
 */
export const STREAM_ID = '00000000-0000-4000-8000-000000000001';

/** Fixed clock so snapshots, ordering, and rendered timestamps are reproducible across runs. */
export const FIXED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
export const FIXED_NOW_ISO = new Date(FIXED_NOW_MS).toISOString();

export interface RpcRequestFrame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
}

export interface RpcResultFrame {
  readonly id: string | number;
  readonly result: unknown;
}

export interface RpcErrorFrame {
  readonly id: string | number;
  readonly error: { code: number; message: string; data?: unknown };
}

export interface NotificationFrame {
  readonly method: string;
  readonly protocolVersion: number;
  readonly streamId: string;
  /** Omitted for unnumbered notifications, which bypass ordering and are always delivered. */
  readonly eventId?: number;
  readonly params: unknown;
}

export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  serverError: -32000,
  forbidden: -32003,
  notFound: -32004,
  overloaded: -32005,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export function notFound(message: string): RpcError {
  return new RpcError(RPC_ERROR.notFound, message);
}

export function invalidParams(message: string): RpcError {
  return new RpcError(RPC_ERROR.invalidParams, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringParam(params: unknown, key: string): string | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
