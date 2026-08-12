import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { inventoryRouter } from './routes/inventory-router';
import { batchesRouter }   from './routes/batches-router';

const app = express();

// Trust exactly one proxy hop (the nginx gateway) so req.ip reflects the real
// client instead of always resolving to the gateway container's address.
app.set('trust proxy', 1);

app.use(corsMiddleware);
app.use(helmet());
app.use(express.json({ limit: '512kb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'inventory', ts: new Date().toISOString() });
});

// All inventory routes require a valid tenant context
app.use('/api/v1/inventory', tenantContextMiddleware, inventoryRouter, batchesRouter);

app.use(globalErrorHandler('inventory'));

export { app };
