import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, corsMiddleware } from '@retail/middleware';

/**
 * No tenant-scoped REST API here — this service's only real surface is the
 * WebSocket server (see socket.ts), attached to the same underlying HTTP
 * server in server.ts. This Express app exists solely for a health check,
 * matching every other service's shape (see services/shifts/src/app.ts).
 */
const app = express();

app.set('trust proxy', 1);

app.use(corsMiddleware);
app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'realtime', ts: new Date().toISOString() });
});

export { app };
