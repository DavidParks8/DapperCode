import type { ApprovalPolicy } from '@bridge/types/types';
import { LOCAL_RPC_ERROR, LocalRpcError } from './errors';

export type RpcParams = Record<string, unknown>;

export function readApprovalPolicy(params: RpcParams, required = false): ApprovalPolicy | null {
  const policy = params['approvalPolicy'];
  if (!required && (policy === undefined || policy === null)) {
    return null;
  }
  if (
    policy !== 'untrusted' &&
    policy !== 'on-request' &&
    policy !== 'on-failure' &&
    policy !== 'never'
  ) {
    throw new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'A valid approval policy is required.', {
      error: 'on_device_failed',
    });
  }
  return policy;
}

export function readParam(params: RpcParams, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Reads a workspace-relative path exactly as sent. Paths are never trimmed, because surrounding
 * whitespace is part of a valid file name; `null` means the caller omitted the path.
 */
export function readPathParam(params: RpcParams, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' ? value : null;
}

export function readRecord(value: unknown): RpcParams {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RpcParams) : {};
}
