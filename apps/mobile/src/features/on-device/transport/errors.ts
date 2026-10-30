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

export function failure(error: unknown): LocalRpcError {
  if (error instanceof LocalRpcError) {
    return error;
  }
  return new LocalRpcError(
    LOCAL_RPC_ERROR.serverError,
    error instanceof Error ? error.message : 'The on-device operation failed.',
    { error: 'on_device_failed' },
  );
}
