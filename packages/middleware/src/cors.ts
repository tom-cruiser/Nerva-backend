import { Request, Response, NextFunction } from 'express';

/**
 * Minimal CORS middleware — no external dependencies.
 *
 * In production all traffic goes through nginx (which adds CORS headers) so
 * this is only active when services are hit directly (local dev without the
 * gateway, integration tests, Postman, etc.).
 *
 * Allowed origins:
 *   - CORS_ALLOWED_ORIGINS env var (comma-separated list)
 *   - Falls back to http://localhost:3000 so the Next.js dev server just works.
 *
 * Credentials are permitted so the frontend can send cookies (refresh_token)
 * and the Authorization header.
 */

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://localhost:8080'];

function resolveAllowedOrigins(): Set<string> {
  const raw = process.env['CORS_ALLOWED_ORIGINS'];
  if (raw && raw.trim()) {
    const custom = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return new Set([...DEFAULT_ORIGINS, ...custom]);
  }
  return new Set(DEFAULT_ORIGINS);
}

// Evaluated once at module load — services reload on env change in dev.
const ALLOWED_ORIGINS = resolveAllowedOrigins();

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers['origin'];

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type,X-Client-Mutation-Id,X-Tenant-Id,X-Request-Id',
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
