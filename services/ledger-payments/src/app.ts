import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { ledgerRouter } from './routes/ledger-router';

console.log('[app] 🚀 Starting ledger-payments service...');

const app = express();

// Trust exactly one proxy hop (the nginx gateway) so req.ip reflects the real
// client instead of always resolving to the gateway container's address.
app.set('trust proxy', 1);

// Middleware
app.use(corsMiddleware);
app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(requestId);

// Health check
app.get('/health', (_req, res) => {
  console.log('[app] Health check called');
  res.json({ 
    status: 'ok', 
    service: 'ledger-payments', 
    ts: new Date().toISOString() 
  });
});

// ✅ DIRECT TEST ROUTE - Bypasses the router
app.get('/api/v1/ledger/test-direct', (req, res) => {
  console.log('[app] ✅ Direct test endpoint called!');
  res.json({
    status: 'ok',
    message: 'Direct test endpoint is working!',
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
  });
});

// ✅ DEBUG ROUTES - Shows all registered routes
app.get('/debug/routes', (_req, res) => {
  console.log('[app] Debug routes called');
  const routes: any[] = [];
  const stack = (app as any)._router?.stack || [];
  
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
      routes.push({
        path: layer.route.path,
        methods: methods,
        type: 'route',
      });
    }
    // Handle router middleware
    if (layer.name === 'router' && layer.handle?.stack) {
      const routerPath = layer.regexp?.source || '';
      for (const subLayer of layer.handle.stack) {
        if (subLayer.route) {
          const methods = Object.keys(subLayer.route.methods).join(', ').toUpperCase();
          routes.push({
            path: subLayer.route.path,
            methods: methods,
            type: 'router',
            basePath: routerPath,
          });
        }
      }
    }
  }
  
  res.json({
    totalRoutes: routes.length,
    routes: routes,
    ledgerRouterMounted: true,
    timestamp: new Date().toISOString(),
  });
});

// Mount the ledger router
console.log('[app] Mounting ledger router at /api/v1/ledger...');
app.use('/api/v1/ledger', tenantContextMiddleware, ledgerRouter);
console.log('[app] ✅ Ledger router mounted');

// Global error handler
app.use(globalErrorHandler('ledger-payments'));

console.log('[app] ✅ App configured successfully');

export { app };