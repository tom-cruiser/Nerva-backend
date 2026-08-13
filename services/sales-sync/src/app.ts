import 'dotenv/config';
import express from 'express';
import helmet  from 'helmet';
import {
  requestId,
  tenantContextMiddleware,
  globalErrorHandler,
  corsMiddleware,
} from '@retail/middleware';
import { syncRouter } from './routes/sync-router';
import { analyticsRouter } from './routes/analytics-router';

// Start the BullMQ worker when the app module is loaded.
// Import side-effect only — the worker registers itself with BullMQ.
import './workers/sync-worker';

const app = express();

// Trust exactly one proxy hop (the nginx gateway) so req.ip reflects the real
// client instead of always resolving to the gateway container's address.
app.set('trust proxy', 1);

app.use(corsMiddleware);
app.use(helmet());
// 2 MB ceiling: generous for max-500 batch but bounded
app.use(express.json({ limit: '2mb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sales-sync', ts: new Date().toISOString() });
});

// All sync routes require a verified JWT tenant context
app.use('/api/v1/sync', tenantContextMiddleware, syncRouter);
// Tenant sales-report/registers analytics — mounted under the same /sync
// prefix so no nginx/dev-gateway route change is needed (see analytics-router.ts).
app.use('/api/v1/sync/analytics', tenantContextMiddleware, analyticsRouter);

app.use(globalErrorHandler('sales-sync'));

export { app };
