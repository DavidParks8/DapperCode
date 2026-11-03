export type RpcParams = Record<string, unknown>;

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
