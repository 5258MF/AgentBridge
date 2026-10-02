// Real local MCP peer for stdio and loopback HTTP integration tests; never contacts the network.
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const sdk = process.argv[2];
const mode = process.argv[3] || 'stdio';
const { Server } = require(path.join(sdk, 'server/index.js'));
const { StdioServerTransport } = require(path.join(sdk, 'server/stdio.js'));
const { StreamableHTTPServerTransport } = require(path.join(sdk, 'server/streamableHttp.js'));
const { CallToolRequestSchema, ListToolsRequestSchema } = require(path.join(sdk, 'types.js'));

function createServer() {
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'inspect', description: 'Inspect fixture context', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    toolCalls += 1;
    if (request.params.arguments?.hang) return new Promise(() => {});
    if (request.params.arguments?.resume) {
      extra.closeSSEStream();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (request.params.arguments?.emitStderr) {
      const token = Buffer.from(process.env.MCP_FIXTURE_VALUE || '');
      process.stderr.write(token.subarray(0, 2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.stderr.write(token.subarray(2));
      process.stderr.write('\n');
    }
    const roots = mode === 'stdio' ? await server.listRoots() : { roots: [] };
    return { content: [{ type: 'text', text: 'fixture response' }], structuredContent: {
      name: request.params.name, args: request.params.arguments, cwd: process.cwd(),
      variable: process.env.MCP_FIXTURE_VALUE || null, roots: roots.roots,
    }, _meta: { fixture: true } };
  });
  return server;
}
const server = createServer();
const sessions = new Map();
let deletes = 0;
let initializes = 0;
let openCalls = 0;
let toolCalls = 0;
let resumeGets = 0;
let redirectHits = 0;
let redirectTarget;
function eventStore() {
  const events = new Map();
  let sequence = 0;
  return {
    async storeEvent(streamId, message) {
      const id = String(++sequence);
      events.set(id, { streamId, message });
      return id;
    },
    async getStreamIdForEventId(id) { return events.get(id)?.streamId; },
    async replayEventsAfter(id, { send }) {
      const streamId = events.get(id)?.streamId;
      let after = false;
      for (const [eventId, event] of events) {
        if (after && event.streamId === streamId) await send(eventId, event.message);
        if (eventId === id) after = true;
      }
      return streamId;
    },
  };
}

let listener;
async function shutdown() {
  await server.close().catch(() => {});
  await Promise.all([...sessions.values()].map(({ peer }) => peer.close().catch(() => {})));
  if (listener) listener.close();
  if (redirectTarget) redirectTarget.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);

(async () => {
  if (mode.startsWith('http')) {
    if (mode === 'http-redirect') {
      redirectTarget = http.createServer((_request, response) => { redirectHits += 1; response.writeHead(500).end(); });
      await new Promise((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve));
    }
    listener = http.createServer((request, response) => { void (async () => {
      if (request.headers.authorization !== 'Bearer fixture-token') {
        response.writeHead(401).end('unauthorized');
        return;
      }
      if (request.url === '/stats') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ active: sessions.size, deletes, initializes, openCalls, toolCalls, resumeGets, redirectHits }));
        return;
      }
      if (request.url === '/expire') {
        const expired = [...sessions.values()];
        sessions.clear();
        await Promise.all(expired.map(({ peer }) => peer.close()));
        response.writeHead(200).end();
        return;
      }
      if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
      if (mode === 'http-redirect') {
        response.writeHead(307, { Location: `http://127.0.0.1:${redirectTarget.address().port}/mcp` }).end();
        return;
      }
      if (mode.startsWith('http-stateful')) {
        if (request.method === 'GET' && request.headers['last-event-id']) resumeGets += 1;
        if (request.method === 'DELETE' && mode.endsWith('hang-delete')) return;
        if (request.method === 'DELETE' && mode.endsWith('no-delete')) { response.writeHead(405).end(); return; }
        const sessionId = request.headers['mcp-session-id'];
        let connection = sessions.get(sessionId);
        if (sessionId && !connection) { response.writeHead(404).end('Session expired'); return; }
        let body;
        if (request.method === 'POST') {
          let text = '';
          for await (const chunk of request) text += chunk;
          body = JSON.parse(text);
        }
        if (!connection) {
          if (body?.method !== 'initialize') { response.writeHead(400).end('Initialize first'); return; }
          initializes += 1;
          if (mode.endsWith('partial-init')) {
            const id = randomUUID();
            sessions.set(id, { peer: createServer() });
            response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
            response.write('{"jsonrpc":"2.0",');
            return;
          }
          const peer = createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID, enableJsonResponse: !mode.includes('sse'),
            eventStore: mode.includes('sse') ? eventStore() : undefined, retryInterval: 25,
            onsessioninitialized: (id) => sessions.set(id, { peer, transport }),
            onsessionclosed: (id) => { sessions.delete(id); deletes += 1; },
          });
          await peer.connect(transport);
          connection = { peer, transport };
        }
        if (request.method === 'DELETE' && mode.endsWith('partial-init')) {
          sessions.delete(sessionId); deletes += 1; response.writeHead(204).end(); return;
        }
        if (body?.method === 'tools/call') {
          openCalls += 1;
          response.on('close', () => { openCalls -= 1; });
        }
        await connection.transport.handleRequest(request, response, body);
        return;
      }
      const peer = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on('close', () => { void peer.close(); });
      void peer.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => { if (!response.headersSent) response.writeHead(500).end(); });
    })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); }); });
    listener.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: listener.address().port }) + '\n'));
    process.stdin.resume();
  } else {
    await server.connect(new StdioServerTransport());
  }
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
