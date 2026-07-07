import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler } from '@retail/middleware';
import { inventoryRouter } from './routes/inventory-router';

const app = express();

app.use(helmet());
app.use(express.json({ limit: '512kb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'inventory', ts: new Date().toISOString() });
});

// All inventory routes require a valid tenant context
app.use('/api/v1/inventory', tenantContextMiddleware, inventoryRouter);

app.use(globalErrorHandler);

export { app };
