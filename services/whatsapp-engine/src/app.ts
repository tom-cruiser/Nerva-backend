import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler } from '@retail/middleware';
import { webhookRouter } from './routes/webhook-router';

const app = express();

app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-engine', ts: new Date().toISOString() });
});

// Inbound Twilio webhook callbacks (no tenant auth — validated by Twilio signature)
app.use('/webhooks/whatsapp', webhookRouter);

// Internal triggered sends (requires tenant context)
app.use('/api/v1/whatsapp', tenantContextMiddleware, webhookRouter);

app.use(globalErrorHandler);

export { app };
