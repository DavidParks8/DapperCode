export type RpcParams = Record<string, unknown>;

export function readParam(params: RpcParams, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readRecord(value: unknown): RpcParams {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RpcParams) : {};
}
