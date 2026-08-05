/**
 * Wire protocol constants and envelope types for the harness bridge.
 *
 * The mobile client does not speak strict JSON-RPC 2.0: it never sends a `jsonrpc` field and never
 * requires one back. Frames are correlated purely by echoing the request `id`. See
 * `apps/mobile/src/bridge/ws/socketTransportLayer.ts` for the client side of this contract.
 */

import { errorCode, manifest } from './contract.ts';

/**
 * The protocol version this harness actually implements.
 *
 * This is deliberately pinned rather than read from the manifest. Inheriting the number would make
 * the harness advertise a new protocol version the moment the real bridge bumped it, without a line
 * of the new semantics being implemented — the tests would keep passing while silently asserting
 * against a protocol that no longer exists. Pinning turns that bump into a loud failure.
 *
 * When the manifest moves, implement the new envelopes and semantics here, then raise this number.
 */
export const IMPLEMENTED_PROTOCOL_VERSION = 2;

if (manifest.protocolVersion !== IMPLEMENTED_PROTOCOL_VERSION) {
  throw new Error(
    `The bridge contract is at protocol version ${String(manifest.protocolVersion)}, but the e2e ` +
      `harness implements version ${String(IMPLEMENTED_PROTOCOL_VERSION)}. Update the harness to ` +
      `speak the new protocol, then raise IMPLEMENTED_PROTOCOL_VERSION in e2e/harness/protocol.ts. ` +
      `Do not simply sync the number: the point of this check is to stop the harness claiming ` +
      `support it does not have.`,
  );
}

export const PROTOCOL_VERSION = IMPLEMENTED_PROTOCOL_VERSION;

/**
 * Identity of the harness event stream. It must stay constant for the lifetime of a bridge:
 * changing it makes the client discard its delivery epoch and demand a full resync.
 */
export const STREAM_ID = manifest.fixtures.capabilities.streamId;

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

/** Error codes resolved by name from the contract, so a renumbering cannot silently diverge. */
export const RPC_ERROR = {
  parseError: errorCode('parseError'),
  invalidRequest: errorCode('invalidRequest'),
  methodNotFound: errorCode('methodNotFound'),
  invalidParams: errorCode('invalidParams'),
  serverError: errorCode('serverError'),
  forbidden: errorCode('forbidden'),
  notFound: errorCode('notFound'),
  overloaded: errorCode('overloaded'),
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

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readRecordParam(params: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  return isRecord(value) ? value : null;
}

export function readStringParam(params: unknown, key: string): string | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
