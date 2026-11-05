/** Host extension outside the Rust contract, gated by the profile's modelLibrary capability. */
export const MODEL_HOST_METHODS = { setDefault: 'model/default/set' } as const;

export interface SetDefaultModelResult {
  modelId: string;
}

export interface ModelHostTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
}

export function setHostDefaultModel(
  transport: ModelHostTransport,
  modelId: string,
): Promise<SetDefaultModelResult> {
  return transport.request(MODEL_HOST_METHODS.setDefault, { modelId });
}
