import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { ledgerRouter } from './routes/ledger-router';

const app = express();

app.use(corsMiddleware);
app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ledger-payments', ts: new Date().toISOString() });
});

app.use('/api/v1/ledger', tenantContextMiddleware, ledgerRouter);

app.use(globalErrorHandler);

export { app };
