/**
 * Dev-only API gateway (Node, zero deps).
 *
 * Mirrors gateway/nginx.conf routing so the frontend can talk to the backend on
 * a single origin (http://localhost:8080) during local development WITHOUT
 * Docker/nginx. Also injects permissive CORS headers + preflight handling, which
 * neither nginx nor the services provide (frontend :3000 → gateway :8080 is
 * cross-origin). NOT for production — use the real nginx gateway there.
 */
const http = require('http');

const PORT = Number(process.env.GATEWAY_PORT || 8080);

// Longest-prefix match wins (so /api/v1/sync beats a hypothetical /api/v1).
const ROUTES = [
  { prefix: '/api/v1/auth/',      port: 3001 },
  { prefix: '/api/v1/inventory/', port: 3002 },
  { prefix: '/api/v1/sales/',     port: 3003 },
  { prefix: '/api/v1/sync/',      port: 3003 },
  { prefix: '/api/v1/ledger/',    port: 3004 },
  { prefix: '/api/v1/whatsapp/',  port: 3005 },
  { prefix: '/api/v1/shifts/',    port: 3006 },
  { prefix: '/api/v1/superadmin/', port: 3007 },
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

server.listen(PORT, () => {
  console.log(`[dev-gateway] listening on http://localhost:${PORT}`);
  for (const r of ROUTES) console.log(`  ${r.prefix} -> :${r.port}`);
});
