import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import {
  executeWebFetch,
  webFetchApproval,
  WEB_FETCH_TIMEOUT_MS,
  type WebFetchRequest,
} from './webFetch';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder });

function page(chunks: string[] = ['page contents'], contentType = 'text/html') {
  const encoder = new TextEncoder();
  const cancel = jest.fn();
  const response = {
    status: 200,
    headers: new Headers({ 'Content-Type': contentType }),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
      cancel,
    }),
  };
  const request = jest.fn<ReturnType<WebFetchRequest>, Parameters<WebFetchRequest>>(
    async () => response,
  );
  return { request, response, cancel };
}

afterEach(() => jest.useRealTimers());

test('reads text through a credential-free GET and returns source metadata, not rendered HTML', async () => {
  const h = page(['<h1>Documentation</h1>']);
  const result = await executeWebFetch({ url: 'https://docs.example/guide' }, undefined, h.request);
  expect(result).toEqual({
    url: 'https://docs.example/guide',
    status: 200,
    contentType: 'text/html',
    content: '<h1>Documentation</h1>',
    truncated: false,
    nextOffset: null,
  });
  expect(h.request).toHaveBeenCalledWith('https://docs.example/guide', {
    method: 'GET',
    credentials: 'omit',
    redirect: 'manual',
    headers: { Accept: 'text/*, application/json, application/xml' },
    signal: expect.any(AbortSignal),
  });
});

test('approval shows the entire normalized URL, including search terms and query parameters', () => {
  expect(webFetchApproval({ url: 'https://SEARCH.example/?q=rust+async&source=phone' })).toContain(
    'https://search.example/?q=rust+async&source=phone',
  );
});

test.each([
  { url: 'http://example.com' },
  { url: 'file:///private/file' },
  { url: 'javascript:alert(1)' },
  { url: '//example.com' },
  { url: 'https://user:password@example.com' },
  { url: 'https://example.com/#fragment' },
  { url: 'https://example.com', headers: { Authorization: 'secret' } },
  { url: 'https://example.com', method: 'POST' },
  { url: 'https://example.com', body: 'private code' },
  { url: 'https://example.com', limit: 16_385 },
  { url: 'https://example.com', offset: 262_145 },
  { url: 'https://example.com', offset: -1 },
  { url: 'https://example.com', limit: 0 },
  { url: 'https://example.com', limit: 1.5 },
  null,
])('rejects unsupported arguments before approval or networking: %j', async (input) => {
  const h = page();
  expect(() => webFetchApproval(input)).toThrow();
  await expect(executeWebFetch(input, undefined, h.request)).rejects.toThrow();
  expect(h.request).not.toHaveBeenCalled();
});

test('bounded chunks expose truncation and a working nextOffset without reading the whole response', async () => {
  const h = page(['abcdef', 'ghijkl', 'remaining data']);
  expect(
    await executeWebFetch({ url: 'https://example.com', limit: 4 }, undefined, h.request),
  ).toMatchObject({
    content: 'abcd',
    truncated: true,
    nextOffset: 4,
  });
  expect(h.cancel).toHaveBeenCalledTimes(1);
  const next = page(['abcdef', 'ghijkl']);
  expect(
    await executeWebFetch(
      { url: 'https://example.com', offset: 4, limit: 4 },
      undefined,
      next.request,
    ),
  ).toMatchObject({
    content: 'efgh',
    truncated: true,
    nextOffset: 8,
  });
  const last = page(['abcdef', 'ghijkl']);
  expect(
    await executeWebFetch(
      { url: 'https://example.com', offset: 8, limit: 4 },
      undefined,
      last.request,
    ),
  ).toMatchObject({
    content: 'ijkl',
    truncated: false,
    nextOffset: null,
  });
});

test('decodes UTF-8 characters split across transport chunks', async () => {
  const h = page();
  const bytes = new TextEncoder().encode('A\u20acB');
  h.response.body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    },
  });
  expect(
    await executeWebFetch(
      { url: 'https://example.com', offset: 1, limit: 2 },
      undefined,
      h.request,
    ),
  ).toMatchObject({
    content: '\u20acB',
    truncated: false,
  });
});

test('the byte budget bounds large downloads even when an offset is requested', async () => {
  const h = page(['a'.repeat(1024 * 1024 + 1)]);
  await expect(
    executeWebFetch({ url: 'https://example.com', offset: 262_144 }, undefined, h.request),
  ).rejects.toThrow('1 MiB');
});

test.each(['image/png', 'application/octet-stream', ''])(
  'rejects non-text content: %s',
  async (type) => {
    const h = page(['binary'], type);
    await expect(
      executeWebFetch({ url: 'https://example.com' }, undefined, h.request),
    ).rejects.toThrow('supported text');
  },
);

test.each([
  'application/json',
  'application/problem+json',
  'application/rss+xml',
  'text/plain; charset=utf-8',
])('accepts text content: %s', async (type) => {
  const h = page(['{}'], type);
  expect(await executeWebFetch({ url: 'https://example.com' }, undefined, h.request)).toMatchObject(
    { content: '{}' },
  );
});

test.each([401, 403, 404, 429, 500])('surfaces HTTP %s as a tool error', async (status) => {
  const h = page();
  h.response.status = status;
  await expect(
    executeWebFetch({ url: 'https://example.com' }, undefined, h.request),
  ).rejects.toThrow(`HTTP ${status}`);
});

test('reports redirects without following or hiding them', async () => {
  const h = page();
  h.response.status = 302;
  h.response.headers.set('location', '/redirected');
  await expect(
    executeWebFetch({ url: 'https://example.com' }, undefined, h.request),
  ).rejects.toThrow(
    'Redirect not followed; request this URL separately: https://example.com/redirected',
  );
  expect(h.request).toHaveBeenCalledTimes(1);
});

test('a stopped request does not start networking', async () => {
  const h = page();
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeWebFetch({ url: 'https://example.com' }, controller.signal, h.request),
  ).rejects.toThrow('stopped');
  expect(h.request).not.toHaveBeenCalled();
});

function pendingRequest() {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const request = jest.fn<ReturnType<WebFetchRequest>, Parameters<WebFetchRequest>>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        started();
      }),
  );
  return { request, ready };
}

test('stop aborts an in-flight request', async () => {
  const h = pendingRequest();
  const controller = new AbortController();
  const result = executeWebFetch({ url: 'https://example.com' }, controller.signal, h.request);
  await h.ready;
  controller.abort();
  await expect(result).rejects.toThrow('stopped');
});

test('the 15-second deadline aborts waiting for response headers', async () => {
  jest.useFakeTimers();
  const h = pendingRequest();
  const result = executeWebFetch({ url: 'https://example.com' }, undefined, h.request);
  const failure = result.catch((error: unknown) => error);
  await h.ready;
  await jest.advanceTimersByTimeAsync(WEB_FETCH_TIMEOUT_MS);
  expect(await failure).toEqual(
    expect.objectContaining({ message: 'The web request timed out after 15 seconds.' }),
  );
  expect(jest.getTimerCount()).toBe(0);
});

test('the deadline also covers a stalled response body', async () => {
  jest.useFakeTimers();
  const h = page();
  const request: WebFetchRequest = (_url, init) => {
    h.response.body = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new Error('Aborted')));
      },
    });
    return Promise.resolve(h.response);
  };
  const result = executeWebFetch({ url: 'https://example.com' }, undefined, request);
  const failure = result.catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(WEB_FETCH_TIMEOUT_MS);
  expect(await failure).toEqual(
    expect.objectContaining({ message: 'The web request timed out after 15 seconds.' }),
  );
});

test('transport errors remain explicit', async () => {
  const h = page();
  h.request.mockRejectedValueOnce(new Error('Network unavailable'));
  await expect(
    executeWebFetch({ url: 'https://example.com' }, undefined, h.request),
  ).rejects.toThrow('Network unavailable');
});
