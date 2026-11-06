import fs from 'node:fs';
import https from 'node:https';

const [certificate, privateKey] = process.argv.slice(2);
const requests = [];
const server = https.createServer(
  {
    cert: fs.readFileSync(certificate),
    key: fs.readFileSync(privateKey),
  },
  async (request, response) => {
    if (request.method === 'GET' && request.url === '/state') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ requests }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404);
      response.end('Fixture route not found.');
      return;
    }
    let text = '';
    for await (const chunk of request) {
      text += chunk.toString('utf8');
      if (text.length > 8_192) {
        response.writeHead(413);
        response.end('Search fixture request exceeded its budget.');
        return;
      }
    }
    const body = JSON.parse(text);
    const args = body.params?.arguments;
    const target = request.headers['x-dappercode-fixture-target'];
    if (
      target !== 'https://mcp.exa.ai/mcp' ||
      request.headers.authorization ||
      body.jsonrpc !== '2.0' ||
      body.id !== 1 ||
      body.method !== 'tools/call' ||
      body.params?.name !== 'web_search_exa' ||
      typeof args?.query !== 'string' ||
      !args.query.trim() ||
      args.query.length > 1000 ||
      !Number.isInteger(args.numResults) ||
      args.numResults < 1 ||
      args.numResults > 8
    ) {
      response.writeHead(400);
      response.end('Unexpected search transport, query, credentials, or MCP request.');
      return;
    }
    requests.push({ target, query: args.query, limit: args.numResults });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: 'Title: IANA Example Domain\nURL: https://example.com/\nContent: Example Domain is reserved by IANA for documentation examples. Owned deterministic MCP transport fixture.',
            },
          ],
        },
      }),
    );
  },
);
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The search fixture did not bind its owned TCP port.');
  }
  console.log(`SEARCH_FIXTURE_PORT=${address.port}`);
});
