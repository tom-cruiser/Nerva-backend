import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestId, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { authRouter } from './routes/auth-router';

const app = express();

// Trust exactly one proxy hop (the nginx gateway — see gateway/nginx.conf,
// which sets X-Forwarded-For via $proxy_add_x_forwarded_for). Without this,
// req.ip always resolves to the gateway's own address for every request,
// collapsing per-client rate limiting (login/register) into one shared
// platform-wide bucket. `1` (not `true`) so only the gateway's own
// appended hop is trusted, not an arbitrary client-supplied header.
app.set('trust proxy', 1);

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
app.use(globalErrorHandler('auth-tenant'));

export { app };
