/**
 * Dev-only API gateway (Node, zero deps).
 *
 * Mirrors gateway/nginx.conf routing so the frontend can talk to the backend on
 * a single origin (http://localhost:8080) during local development WITHOUT
 * Docker/nginx. Also injects permissive CORS headers + preflight handling, which
 * neither nginx nor the services provide (frontend :3000 → gateway :8080 is
 * cross-origin). NOT for production — use the real nginx gateway there.
 *
 * NOTE: this is a duplicate of scripts/dev-gateway.js (used by
 * scripts/run-all-local.sh) — this copy backs the root package.json's `dev`
 * concurrently script instead. Keep both in sync.
 */
const http = require('http');
const net = require('net');

const PORT = Number(process.env.GATEWAY_PORT || 8080);

// Longest-prefix match wins (so /api/v1/sync beats a hypothetical /api/v1).
const ROUTES = [
  { prefix: '/api/v1/auth/',      port: 3001 },
  { prefix: '/api/v1/inventory/', port: 3002 },
  // NOTE: sales-sync only mounts /api/v1/sync (+ /api/v1/sync/analytics) —
  // there was never an /api/v1/sales/* handler, so that stale route entry
  // (always a 404) has been removed rather than kept as dead routing.
  { prefix: '/api/v1/sync/',      port: 3003 },
  { prefix: '/api/v1/ledger/',    port: 3004 },
  { prefix: '/api/v1/whatsapp/',  port: 3005 },
  { prefix: '/api/v1/shifts/',    port: 3006 },
  { prefix: '/api/v1/superadmin/', port: 3007 },
  // services/realtime — Socket.IO's client defaults to polling GET/POST
  // requests AND a ws:// upgrade both under this same path, so both the
  // plain-HTTP proxy below and the upgrade handler need this route.
  { prefix: '/socket.io/',        port: 3008 },
].sort((a, b) => b.prefix.length - a.prefix.length);

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ||
      'Authorization,Content-Type,X-Client-Mutation-Id,X-Tenant-Id',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer((req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', gateway: 'dev', ts: new Date().toISOString() }));
    return;
  }

  const route = ROUTES.find((r) => req.url.startsWith(r.prefix));
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No route for ' + req.url, code: 'NOT_FOUND' }));
    return;
  }

  const proxyReq = http.request(
    { host: '127.0.0.1', port: route.port, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Upstream :${route.port} unreachable (${err.code || err.message})`,
      code: 'BAD_GATEWAY',
    }));
  });

  req.pipe(proxyReq);
});

// WebSocket upgrade proxying — plain http.request (above) never fires for an
// `Upgrade: websocket` request, Node emits a separate 'upgrade' event on the
// server instead. Hand-rolled with a raw TCP socket (no added dependency,
// matching this file's own "zero deps" design) rather than a full proxy
// library: connect to the upstream, replay the original request line/headers,
// then pipe both directions.
server.on('upgrade', (req, clientSocket, head) => {
  const route = ROUTES.find((r) => req.url.startsWith(r.prefix));
  if (!route) {
    clientSocket.destroy();
    return;
  }

  const upstreamSocket = net.connect(route.port, '127.0.0.1', () => {
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
    const headerLines = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstreamSocket.write(`${[requestLine, ...headerLines].join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstreamSocket.write(head);

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', (err) => {
    console.error(`[dev-gateway] Upgrade upstream :${route.port} error`, err.message);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstreamSocket.destroy());
});

server.listen(PORT, () => {
  console.log(`[dev-gateway] listening on http://localhost:${PORT}`);
  for (const r of ROUTES) console.log(`  ${r.prefix} -> :${r.port}`);
});
