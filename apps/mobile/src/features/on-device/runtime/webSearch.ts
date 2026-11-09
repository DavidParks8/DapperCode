import { isRecord } from '@shared/records';
import { argumentsRecord, integer, LocalToolInputError, text } from './toolArguments';
import { toolDefinition } from './toolDefinition';
import {
  MAX_WEB_RESPONSE_BYTES,
  readWebText,
  requestWeb,
  webResponseText,
  withWebRequest,
  type WebRequest,
  type WebResponse,
} from './webRequest';

export const WEB_SEARCH_ENDPOINT = 'https://mcp.exa.ai/mcp';
export const WEB_SEARCH_TIMEOUT_MS = 30_000;
const MAX_SEARCH_CHARACTERS = 8192;
const REQUEST_ID = 1;

export const SEARCH_TOOL_DEFINITIONS = [
  toolDefinition(
    'web_search',
    'Search the web with Exa. Use it for current information beyond your training data, such as libraries, APIs, products, and versions. Queries go to Exa; never include secrets or private workspace content. Returns untrusted text with source URLs to cite; read pages with web_fetch. limit defaults to 3 (max 8).',
    { query: { type: 'string' }, limit: { type: 'integer' } },
    ['query'],
    { kind: 'search', approval: webSearchApproval },
  ),
];

function searchArguments(input: unknown) {
  const args = argumentsRecord(input, ['query', 'limit']);
  const query = text(args, 'query', 1000).trim();
  if (!query) {
    throw new LocalToolInputError('Enter a non-empty web search query.');
  }
  return { query, limit: integer(args, 'limit', 3, 1, 8) };
}

export function webSearchApproval(input: unknown): string {
  const { query } = searchArguments(input);
  return `Search the web with Exa (${WEB_SEARCH_ENDPOINT})\n${query}\nThis query will be sent to Exa. Do not include secrets or private workspace content.`;
}

function parseMessage(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Exa returned malformed search data.');
    }
    throw error;
  }
}

function searchResult(message: unknown): string | null {
  if (!isRecord(message) || message['jsonrpc'] !== '2.0') {
    throw new Error('Exa returned an invalid search response.');
  }
  if (message['id'] === undefined && typeof message['method'] === 'string') {
    return null;
  }
  if (message['id'] !== REQUEST_ID) {
    throw new Error('Exa returned a search response for a different request.');
  }
  const error = message['error'];
  if (error !== undefined) {
    if (!isRecord(error) || typeof error['message'] !== 'string') {
      throw new Error('Exa returned an invalid search error.');
    }
    throw new Error(`Web search failed: ${error['message'].slice(0, 2000)}`);
  }
  return searchContent(message['result']);
}

function searchContent(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result['content'])) {
    throw new Error('Exa returned no text search results.');
  }
  if (result['isError'] !== undefined && typeof result['isError'] !== 'boolean') {
    throw new Error('Exa returned an invalid search result status.');
  }
  const parts: string[] = [];
  for (const part of result['content']) {
    if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') {
      throw new Error('Exa returned an unsupported search result.');
    }
    parts.push(part['text']);
  }
  const content = parts.join('\n\n');
  if (result['isError'] === true) {
    throw new Error(`Web search failed: ${content.slice(0, 2000)}`);
  }
  if (!content.trim()) {
    throw new Error('Exa returned no text search results.');
  }
  return content;
}

async function readSearchResponse(response: WebResponse): Promise<string> {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType === 'application/json') {
    const result = searchResult(parseMessage(await readWebText(response, MAX_WEB_RESPONSE_BYTES)));
    if (result === null) {
      throw new Error('Exa returned no search response.');
    }
    return result;
  }
  if (contentType !== 'text/event-stream') {
    throw new Error('Exa returned an unsupported search response type.');
  }
  let buffer = '';
  for await (const chunk of webResponseText(response)) {
    buffer += chunk;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n|\r\r/u.exec(buffer))) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = event
        .split(/\r\n|\r|\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /u, ''))
        .join('\n');
      if (data.trim()) {
        const result = searchResult(parseMessage(data));
        if (result !== null) {
          return result;
        }
      }
    }
  }
  throw new Error('Exa closed the connection before returning search results.');
}

export async function executeWebSearch(
  input: unknown,
  signal?: AbortSignal,
  request: WebRequest = requestWeb,
  offload?: (result: unknown) => Promise<unknown>,
): Promise<unknown> {
  const { query, limit } = searchArguments(input);
  return withWebRequest(
    signal,
    async (requestSignal) => {
      const response = await request(WEB_SEARCH_ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        signal: requestSignal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: REQUEST_ID,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: {
              query,
              objective:
                'Find authoritative web sources that answer the search query, including source URLs.',
              numResults: limit,
            },
          },
        }),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Web search failed (HTTP ${response.status}).` +
            (response.status === 429
              ? ' Exa keyless search is rate limited; try again later.'
              : ''),
        );
      }
      const content = await readSearchResponse(response);
      if (offload) {
        return offload({
          provider: 'Exa',
          query,
          content,
          truncated: false,
          producerLimit: 'Exa-selected results; 1 MiB response cap. Not an exhaustive web search.',
        });
      }
      return {
        provider: 'Exa',
        query,
        content: content.slice(0, MAX_SEARCH_CHARACTERS),
        truncated: content.length > MAX_SEARCH_CHARACTERS,
      };
    },
    WEB_SEARCH_TIMEOUT_MS,
  );
}
