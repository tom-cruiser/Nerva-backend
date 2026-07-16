import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestId, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { authRouter } from './routes/auth-router';

const app = express();

// ─── CORS (preflight + origin headers before anything else) ──────────────────
app.use(corsMiddleware);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ─── Request correlation (must be first custom middleware) ────────────────────
app.use(requestId);

// ─── Health probe — unauthenticated ──────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-tenant', ts: new Date().toISOString() });
});

// ─── Domain routes ────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRouter);

// ─── Global error handler (must be last) ─────────────────────────────────────
app.use(globalErrorHandler);

export { app };
