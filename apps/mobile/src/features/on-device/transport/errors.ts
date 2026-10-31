import { isOnDeviceNativeError, type OnDeviceNativeErrorCode } from '../native/services.errors';
import { OnDeviceOfflineError } from '../runtime/network';

/** JSON-RPC error codes from `contracts/bridge-rpc/v2/manifest.json`. */
export const LOCAL_RPC_ERROR = {
  methodNotFound: -32601,
  invalidParams: -32602,
  serverError: -32000,
  notFound: -32004,
} as const;

/**
 * Stable `data.error` reasons a UI can branch on to offer a call to action (for example opening the
 * model library) instead of showing raw text.
 */
export type LocalRpcErrorReason =
  | 'unsupported_on_device'
  | 'thread_not_found'
  | 'on_device_model_required'
  | 'on_device_workspace_required'
  | 'on_device_busy'
  | 'on_device_offline'
  | 'on_device_not_repository'
  | 'on_device_failed';

export class LocalRpcError extends Error {
  override readonly name = 'LocalRpcError';

  constructor(
    readonly code: number,
    message: string,
    readonly data: { error: LocalRpcErrorReason } & Record<string, unknown>,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const WORKSPACE_CODES = new Set<OnDeviceNativeErrorCode>([
  'WORKSPACE_REQUIRED',
  'WORKSPACE_INVALID_ID',
  'WORKSPACE_NOT_FOUND',
]);

/** Maps a runtime or typed native failure to a JSON-RPC error with a stable reason. */
export function failure(error: unknown): LocalRpcError {
  if (error instanceof LocalRpcError) {
    return error;
  }
  if (error instanceof OnDeviceOfflineError) {
    return new LocalRpcError(LOCAL_RPC_ERROR.serverError, error.message, {
      error: 'on_device_offline',
    });
  }
  if (isOnDeviceNativeError(error)) {
    const reason: LocalRpcErrorReason = WORKSPACE_CODES.has(error.code)
      ? 'on_device_workspace_required'
      : error.code === 'GIT_NOT_REPOSITORY'
        ? 'on_device_not_repository'
        : error.code === 'GIT_NETWORK'
          ? 'on_device_offline'
          : 'on_device_failed';
    return new LocalRpcError(LOCAL_RPC_ERROR.serverError, error.message, {
      error: reason,
      nativeCode: error.code,
    });
  }
  return new LocalRpcError(
    LOCAL_RPC_ERROR.serverError,
    error instanceof Error ? error.message : 'The on-device operation failed.',
    { error: 'on_device_failed' },
  );
}
