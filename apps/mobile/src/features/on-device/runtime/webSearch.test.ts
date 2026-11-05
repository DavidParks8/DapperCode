import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { LOCAL_TOOL_DEFINITIONS, localToolApproval } from './localTools';
import { executeWebSearch, WEB_SEARCH_ENDPOINT, WEB_SEARCH_TIMEOUT_MS } from './webSearch';
import type { WebRequest } from './webRequest';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder });

const source =
  'Title: Rust documentation\nURL: https://doc.rust-lang.org/\nHighlights: Official Rust documentation.';
const message = (content = source) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: content }] },
});

function response(chunks = [JSON.stringify(message())], contentType = 'application/json') {
  const cancel = jest.fn();
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
    cancel,
  });
  const value = { status: 200, headers: new Headers({ 'Content-Type': contentType }), body };
  const request = jest.fn<ReturnType<WebRequest>, Parameters<WebRequest>>(async () => value);
  return { request, value, cancel };
}

afterEach(() => jest.useRealTimers());

test('query search and page fetch are both in the default local toolset with no opt-in', () => {
  for (const name of ['web_search', 'web_fetch']) {
    expect(LOCAL_TOOL_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name }),
      }),
    );
  }
  expect(localToolApproval('web_search', { query: 'Rust documentation' })).toMatchObject({
    kind: 'search',
    summary: expect.stringContaining('Rust documentation'),
  });
  expect(localToolApproval('web_fetch', { url: 'https://example.com/' })).not.toBeNull();
  expect(localToolApproval('git_push', {})).not.toBeNull();
});

test('search sends the query and bounded options to keyless Exa and preserves source URLs', async () => {
  const h = response();
  const result = await executeWebSearch({ query: '  Rust documentation  ' }, undefined, h.request);
  expect(result).toEqual({
    provider: 'Exa',
    query: 'Rust documentation',
    content: source,
    truncated: false,
  });
  expect(h.request).toHaveBeenCalledWith(WEB_SEARCH_ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    signal: expect.any(AbortSignal),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: {
          query: 'Rust documentation',
          objective:
            'Find authoritative web sources that answer the search query, including source URLs.',
          numResults: 3,
        },
      },
    }),
  });
});

test('supports explicit result counts', async () => {
  const h = response();
  await executeWebSearch({ query: 'Rust docs', limit: 8 }, undefined, h.request);
  expect(h.request.mock.calls[0]?.[1].body).toContain('"numResults":8');
});

test.each([
  null,
  {},
  { query: '' },
  { query: ' \n ' },
  { query: 'a'.repeat(1001) },
  { query: 5 },
  { query: 'Rust', limit: 0 },
  { query: 'Rust', limit: 9 },
  { query: 'Rust', limit: 2.5 },
  { query: 'Rust', url: 'https://other.example' },
  { query: 'Rust', apiKey: 'not-accepted' },
])('rejects invalid searches before networking: %j', async (input) => {
  const h = response();
  await expect(executeWebSearch(input, undefined, h.request)).rejects.toThrow();
  expect(h.request).not.toHaveBeenCalled();
});

test('reads fragmented multiline SSE, ignores progress notifications, and stops after the matching response', async () => {
  const data = JSON.stringify(message());
  const h = response(
    [
      ': keepalive\r\n\r\n',
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
      `event: message\r\ndata: ${data.slice(0, 17)}`,
      `\r\ndata: ${data.slice(17)}\r`,
      '\n\r\n',
      ': additional events are not needed\r\n\r\n',
    ],
    'text/event-stream; charset=utf-8',
  );
  expect(await executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).toMatchObject({
    content: source,
  });
  expect(h.cancel).toHaveBeenCalledTimes(1);
});

test('accepts SSE line endings used by hosted servers', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const h = response(
      [`data: ${JSON.stringify(message())}${newline}${newline}`],
      'text/event-stream',
    );
    expect(await executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).toMatchObject({
      content: source,
    });
  }
});

test('search output truncation is explicit and bounded independently of transport bytes', async () => {
  const h = response([JSON.stringify(message('x'.repeat(10_000)))]);
  expect(await executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).toMatchObject({
    content: 'x'.repeat(8192),
    truncated: true,
  });
});

test.each([
  '{',
  JSON.stringify({ jsonrpc: '1.0', id: 1, result: message().result }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, result: message().result }),
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
  JSON.stringify({ jsonrpc: '2.0', id: 1, error: 'invalid' }),
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ...message().result, isError: 'false' } }),
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'image', data: 'no' }] } }),
])('invalid provider responses remain visible errors: %s', async (raw) => {
  const h = response([raw]);
  await expect(executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).rejects.toThrow();
});

test.each([
  { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Search unavailable' } },
  {
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: 'Search unavailable' }] },
  },
])('JSON-RPC and tool errors never appear as successful search results', async (error) => {
  const h = response([JSON.stringify(error)]);
  await expect(executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).rejects.toThrow(
    'Search unavailable',
  );
});

test('SSE closed without a result is not a successful empty search', async () => {
  const h = response([': keepalive\n\n'], 'text/event-stream');
  await expect(executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).rejects.toThrow(
    'before returning search results',
  );
});

test.each([302, 401, 403, 429, 500])(
  'HTTP %s is explicit, is not followed or retried',
  async (status) => {
    const h = response();
    h.value.status = status;
    await expect(executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(h.request).toHaveBeenCalledTimes(1);
  },
);

test('unsupported content types and excessive download sizes fail explicitly', async () => {
  const h = response(['<html>Not a search response</html>'], 'text/html');
  await expect(executeWebSearch({ query: 'Rust docs' }, undefined, h.request)).rejects.toThrow(
    'response type',
  );
  const large = response(['x'.repeat(1024 * 1024 + 1)]);
  await expect(executeWebSearch({ query: 'Rust docs' }, undefined, large.request)).rejects.toThrow(
    '1 MiB',
  );
});

test('an already stopped search never starts networking', async () => {
  const h = response();
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeWebSearch({ query: 'Rust docs' }, controller.signal, h.request),
  ).rejects.toThrow('stopped');
  expect(h.request).not.toHaveBeenCalled();
});

test('search deadline covers stalled response data and closes the stream', async () => {
  jest.useFakeTimers();
  const request: WebRequest = (_url, init) =>
    Promise.resolve({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new Error('Aborted')));
        },
      }),
    });
  const failure = executeWebSearch({ query: 'Rust docs' }, undefined, request).catch(
    (error: unknown) => error,
  );
  await jest.advanceTimersByTimeAsync(WEB_SEARCH_TIMEOUT_MS);
  expect(await failure).toEqual(
    expect.objectContaining({ message: 'The web request timed out after 30 seconds.' }),
  );
  expect(jest.getTimerCount()).toBe(0);
});
