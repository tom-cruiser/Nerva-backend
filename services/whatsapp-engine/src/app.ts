import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { webhookRouter } from './routes/webhook-router';
import { whatsappRouter } from './routes/whatsapp-routes';
import { client } from './lib/whatsapp-client';

// Initialize the WhatsApp-Web client engine
client.initialize().catch((err) => {
  console.error('[whatsapp-engine] Failed to initialize WhatsApp client:', err);
});

const app = express();

app.use(corsMiddleware);
app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'whatsapp-engine', 
    whatsapp_status: client.info ? 'READY' : 'INITIALIZING',
    ts: new Date().toISOString() 
  });
});

// 1. Legacy/Twilio Webhooks (Public)
app.use('/webhooks/whatsapp', webhookRouter);

// 2. Internal Management Routes (Requires Tenant Auth)
// This handles QR polling, status checks, and message sending via our bridge
app.use('/api/v1/whatsapp', tenantContextMiddleware, whatsappRouter);

app.use(globalErrorHandler);

export { app };