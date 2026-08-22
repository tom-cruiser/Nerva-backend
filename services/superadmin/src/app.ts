import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { superadminRouter } from './routes/superadmin-router';
import { subscriptionsRouter } from './routes/subscriptions-router';
import { analyticsRouter } from './routes/analytics-router';
import { platformOpsRouter } from './routes/platform-ops-router';
import { settingsRouter } from './routes/settings-router';
import { supportRouter } from './routes/support-router';
import { publicAnnouncementsRouter } from './routes/public-announcements-router';

const app = express();

// Trust exactly one proxy hop (the nginx gateway) so req.ip reflects the real
// client instead of always resolving to the gateway container's address.
app.set('trust proxy', 1);

// ─── CORS (preflight + origin headers before anything else) ──────────────────
app.use(corsMiddleware);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));

// ─── Request correlation (must be first custom middleware) ────────────────────
app.use(requestId);

// ─── Health probe — unauthenticated ──────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'superadmin', ts: new Date().toISOString() });
});

// ─── Public routes — unauthenticated, mounted BEFORE tenantContextMiddleware ──
// Every tenant's frontend polls this to show an announcement banner; it must
// work with no bearer token, the same way GET /health does above. Nothing
// sensitive is exposed (see public-announcements-router.ts's explicit column
// list) — do not add anything else here without the same scrutiny.
app.use('/api/v1/superadmin', publicAnnouncementsRouter);

// ─── Domain routes ────────────────────────────────────────────────────────────
// tenantContextMiddleware still runs first (it verifies the caller's own
// Supabase JWT and resolves ctx.userId/email/permissions). Each router then
// applies its own per-route gate — superadminRouter's tenant-lifecycle
// actions are entirely superadmin-only (router.use(requireSuperadmin())),
// while the newer routers mix `requireAnyPermission('platform:support',
// 'platform:billing', 'superadmin:access')` on reads with narrower,
// per-route gates on writes — see each file for its exact split.
app.use(
  '/api/v1/superadmin',
  tenantContextMiddleware,
  superadminRouter,
  subscriptionsRouter,
  analyticsRouter,
  platformOpsRouter,
  settingsRouter,
  supportRouter,
);

// ─── Global error handler (must be last) ─────────────────────────────────────
app.use(globalErrorHandler('superadmin'));

export { app };
