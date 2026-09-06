import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const image = readFileSync(process.argv[2]);
const boundary = 'DapperCodeATSImageBoundary';
const expected = Buffer.concat([
  ...Object.entries({ kind: 'image', fileName: 'image.png', mimeType: 'image/png' }).map(
    ([key, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
  ),
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
  ),
  image,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
let attempts = 0;
let accepted = 0;
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/observations') {
    response.end(JSON.stringify({ attempts, accepted }));
    return;
  }
  attempts++;
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const valid =
    request.method === 'POST' &&
    request.url === '/attachments' &&
    request.headers.host === `127.0.0.1.nip.io:${server.address().port}` &&
    request.headers['content-type'] === `multipart/form-data; boundary=${boundary}` &&
    Buffer.concat(chunks).equals(expected);
  if (valid) accepted++;
  response.writeHead(valid ? 201 : 400).end(valid ? 'image accepted' : 'invalid upload');
});
server.requestTimeout = 20000;
server.listen(0, '127.0.0.1', () => console.log(`ATS_LISTENING ${server.address().port}`));
