import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';

const [root, certificate, privateKey] = process.argv.slice(2);
const authorization = `Basic ${Buffer.from(
  `${process.env.NATIVE_GIT_USER}:${process.env.NATIVE_GIT_PASSWORD}`,
).toString('base64')}`;

const server = https.createServer(
  { cert: fs.readFileSync(certificate), key: fs.readFileSync(privateKey) },
  (request, response) => {
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Native Git fixture"' });
      response.end('Authentication required.');
      return;
    }
    const url = new URL(request.url, 'https://127.0.0.1');
    if (url.pathname.startsWith('/stalled.git/')) {
      return;
    }
    if (!url.pathname.startsWith('/remote.git/')) {
      response.writeHead(404);
      response.end('Repository not found.');
      return;
    }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: request.headers['content-length'] ?? '',
        REMOTE_USER: process.env.NATIVE_GIT_USER,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let headers = Buffer.alloc(0);
    let sentHeaders = false;
    child.stdout.on('data', (chunk) => {
      if (sentHeaders) {
        response.write(chunk);
        return;
      }
      headers = Buffer.concat([headers, chunk]);
      const boundary = headers.indexOf('\r\n\r\n');
      if (boundary === -1) {
        if (headers.length > 16_384) {
          response.destroy(new Error('Invalid Git backend headers.'));
          child.kill('SIGTERM');
        }
        return;
      }
      let status = 200;
      const outgoing = {};
      for (const line of headers.subarray(0, boundary).toString('utf8').split('\r\n')) {
        const separator = line.indexOf(':');
        if (separator === -1) {
          continue;
        }
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === 'status') {
          status = Number.parseInt(value, 10);
        } else {
          outgoing[name] = value;
        }
      }
      response.writeHead(status, outgoing);
      sentHeaders = true;
      response.write(headers.subarray(boundary + 4));
      headers = Buffer.alloc(0);
    });
    child.stderr.resume();
    child.on('error', () => response.destroy(new Error('Git backend could not start.')));
    child.on('close', (code) => {
      if (code !== 0 || !sentHeaders) {
        response.destroy(new Error(`Git backend failed (${code}).`));
        return;
      }
      response.end();
    });
    request.on('aborted', () => child.kill('SIGTERM'));
    request.pipe(child.stdin);
  },
);
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Git test server did not bind a TCP port.');
  }
  console.log(`NATIVE_GIT_PORT=${address.port}`);
});
