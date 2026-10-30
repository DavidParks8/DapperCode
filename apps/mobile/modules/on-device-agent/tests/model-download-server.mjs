import fs from 'node:fs';
import https from 'node:https';

const [dataFile, certificate, key] = process.argv.slice(2);
const data = fs.readFileSync(dataFile);
const server = https.createServer(
  {
    cert: fs.readFileSync(certificate),
    key: fs.readFileSync(key),
  },
  (request, response) => {
    if (request.url === '/failure.gguf') {
      response.writeHead(503);
      response.end('Fixture unavailable.');
      return;
    }
    if (request.url !== '/model.gguf' && request.url !== '/model-2.gguf') {
      response.writeHead(404);
      response.end();
      return;
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-$/);
    console.log(`MODEL_REQUEST ${request.method} ${request.url} ${range ? 'range' : 'full'}`);
    let offset = range ? Number(range[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.length) {
      response.writeHead(416);
      response.end();
      return;
    }
    if (range) {
      console.log('MODEL_RANGE_REQUEST');
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length - offset,
      'Accept-Ranges': 'bytes',
      ETag: '"native-model-fixture-v1"',
      'Last-Modified': 'Sat, 24 Oct 2026 00:00:00 GMT',
      ...(range ? { 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const timer = setInterval(() => {
      const next = Math.min(data.length, offset + 16 * 1024);
      response.write(data.subarray(offset, next));
      offset = next;
      if (offset === data.length) {
        clearInterval(timer);
        response.end();
      }
    }, 20);
    response.on('close', () => clearInterval(timer));
  },
);
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The model fixture did not bind a TCP port.');
  }
  console.log(`MODEL_DOWNLOAD_PORT=${address.port}`);
});
