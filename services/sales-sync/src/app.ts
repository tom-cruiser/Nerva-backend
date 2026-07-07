import 'dotenv/config';
import express from 'express';
import helmet  from 'helmet';
import {
  requestId,
  tenantContextMiddleware,
  globalErrorHandler,
} from '@retail/middleware';
import { syncRouter } from './routes/sync-router';

// Start the BullMQ worker when the app module is loaded.
// Import side-effect only — the worker registers itself with BullMQ.
import './workers/sync-worker';

const app = express();

app.use(helmet());
// 2 MB ceiling: generous for max-500 batch but bounded
app.use(express.json({ limit: '2mb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sales-sync', ts: new Date().toISOString() });
});

// All sync routes require a verified JWT tenant context
app.use('/api/v1/sync', tenantContextMiddleware, syncRouter);

app.use(globalErrorHandler);

export { app };
