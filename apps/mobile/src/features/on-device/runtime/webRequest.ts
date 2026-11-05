import { fetch as expoFetch } from 'expo/fetch';

export const WEB_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_WEB_RESPONSE_BYTES = 1024 * 1024;

export interface WebResponse {
  status: number;
  headers: Pick<Headers, 'get'>;
  body: {
    getReader(): Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'>;
  } | null;
}

export type WebRequest = (url: string, init: RequestInit) => Promise<WebResponse>;

// Expo supports streaming and manual redirects on iOS; RN's global fetch does not.
export const requestWeb: WebRequest = expoFetch;

export async function* webResponseText(response: WebResponse): AsyncGenerator<string> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        yield decoder.decode();
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_WEB_RESPONSE_BYTES) {
        throw new Error('The web response exceeded the 1 MiB download limit. Use a smaller page.');
      }
      yield decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function readWebText(response: WebResponse, end: number): Promise<string> {
  let content = '';
  for await (const chunk of webResponseText(response)) {
    content += chunk;
    if (content.length > end) {
      break;
    }
  }
  return content;
}

export async function withWebRequest<T>(
  signal: AbortSignal | undefined,
  perform: (signal: AbortSignal) => Promise<T>,
  timeoutMs = WEB_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) {
    controller.abort();
  }
  const timeout = setTimeout(cancel, timeoutMs);
  try {
    if (controller.signal.aborted) {
      throw new Error('The web request was stopped.');
    }
    return await perform(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        signal?.aborted
          ? 'The web request was stopped.'
          : `The web request timed out after ${timeoutMs / 1000} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
