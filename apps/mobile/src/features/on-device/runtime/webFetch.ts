import { argumentsRecord, integer, LocalToolInputError, text } from './toolArguments';
import { toolDefinition } from './toolDefinition';
import {
  MAX_WEB_RESPONSE_BYTES,
  readWebText,
  requestWeb,
  withWebRequest,
  type WebRequest,
  type WebResponse,
} from './webRequest';

export { WEB_REQUEST_TIMEOUT_MS as WEB_FETCH_TIMEOUT_MS } from './webRequest';
export type { WebRequest as WebFetchRequest } from './webRequest';
const MAX_OFFSET = 256 * 1024;

export const WEB_TOOL_DEFINITIONS = [
  toolDefinition(
    'web_fetch',
    'GET an HTTPS URL as raw text/HTML, without cookies or credentials; follow a redirect with a new request. offset/limit count characters (limit default 4096, max 16384).',
    { url: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
    ['url'],
    { kind: 'fetch', approval: webFetchApproval },
  ),
];

function fetchArguments(input: unknown) {
  const args = argumentsRecord(input, ['url', 'offset', 'limit']);
  const raw = text(args, 'url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalToolInputError('Enter an absolute HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new LocalToolInputError('Use an HTTPS URL without embedded credentials or a fragment.');
  }
  return {
    url: url.href,
    offset: integer(args, 'offset', 0, 0, MAX_OFFSET),
    limit: integer(args, 'limit', 4096, 1, 16_384),
  };
}

export function webFetchApproval(input: unknown): string {
  const { url } = fetchArguments(input);
  return `Fetch ${url}\nThe full URL, including its query, will be sent to this server. Only approve URLs you trust.`;
}

function isText(contentType: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    mime.startsWith('text/') ||
    /^application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml|[\w.-]+\+json)$/u.test(mime)
  );
}

function textContentType(response: WebResponse, url: string): string {
  if (response.status < 200 || response.status >= 300) {
    const location = response.headers.get('location');
    throw new Error(
      `Web request failed (HTTP ${response.status}).` +
        (location
          ? ` Redirect not followed; request this URL separately: ${new URL(location, url).href}`
          : ''),
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!isText(contentType)) {
    throw new Error('The web response is not a supported text, HTML, JSON, or XML document.');
  }
  return contentType;
}

export async function executeWebFetch(
  input: unknown,
  signal?: AbortSignal,
  request: WebRequest = requestWeb,
  offload?: (result: unknown) => Promise<unknown>,
): Promise<unknown> {
  const { url, offset, limit } = fetchArguments(input);
  return withWebRequest(signal, async (requestSignal) => {
    const response = await request(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      headers: { Accept: 'text/*, application/json, application/xml' },
      signal: requestSignal,
    });
    const contentType = textContentType(response, url);
    const content = await readWebText(response, offload ? MAX_WEB_RESPONSE_BYTES : offset + limit);
    if (offload && content.length > 4096) {
      return offload({
        url,
        status: response.status,
        contentType,
        content,
        truncated: false,
        producerLimit:
          'Complete decoded response body within the 1 MiB download cap; not a rendered page.',
        requestedOffset: offset,
      });
    }
    const truncated = content.length > offset + limit;
    return {
      url,
      status: response.status,
      contentType,
      content: content.slice(offset, offset + limit),
      truncated,
      nextOffset: truncated && offset + limit <= MAX_OFFSET ? offset + limit : null,
    };
  });
}
