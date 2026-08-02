export class RpcRequestError extends Error {
  override readonly name = 'RpcRequestError';

  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isRpcRequestError(error: unknown): error is RpcRequestError {
  return error instanceof RpcRequestError;
}

export class BridgeProtocolVersionError extends Error {
  override readonly name = 'BridgeProtocolVersionError';

  constructor(readonly receivedVersion: number) {
    super(`Unsupported bridge protocol version ${String(receivedVersion)}; expected ${String(2)}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
