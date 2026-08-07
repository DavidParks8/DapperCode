import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface StaticSiteServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serves an Expo `output: "single"` web export as a single-page app.
 *
 * The listener always binds port 0 so any number of workers, and any number of concurrent test
 * runs, can serve their own copy without coordinating on a port.
 */
export async function startStaticSiteServer(rootDir: string): Promise<StaticSiteServer> {
  const server = createServer((request, response) => {
    handleRequest(rootDir, request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  rootDir: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const resolved = resolveWithinRoot(rootDir, requestedPath);
  const filePath = resolved === null ? null : await resolveFile(resolved);

  // Unknown paths fall back to the SPA shell so client-side routes such as
  // /profiles/<id>/chat/<id> load directly instead of 404ing.
  const target = filePath ?? path.join(rootDir, 'index.html');
  const info = await statOrNull(target);
  if (!info?.isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}

function resolveWithinRoot(rootDir: string, requestedPath: string): string | null {
  const decoded = safeDecode(requestedPath);
  if (decoded === null) {
    return null;
  }
  const resolved = path.resolve(rootDir, `.${path.posix.normalize(decoded)}`);
  const relative = path.relative(rootDir, resolved);
  const escapesRoot = relative.startsWith('..') || path.isAbsolute(relative);
  return escapesRoot ? null : resolved;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function resolveFile(candidate: string): Promise<string | null> {
  const info = await statOrNull(candidate);
  if (info?.isFile()) {
    return candidate;
  }
  if (info?.isDirectory()) {
    const index = path.join(candidate, 'index.html');
    return (await statOrNull(index))?.isFile() ? index : null;
  }
  return null;
}

async function statOrNull(target: string) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}
