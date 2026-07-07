import { z } from 'zod';

/**
 * Cluster-wide environment schema.
 *
 * Every service imports `env` from this module as the FIRST import in server.ts.
 * If any required variable is missing or malformed, the process exits immediately
 * with a human-readable error — fail-fast at startup, never at request time.
 *
 * Variable naming follows the existing .env.example conventions while satisfying
 * the exact schema shape specified in the implementation requirements.
 */
const envSchema = z.object({
  // ─── Runtime ───────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  PORT:     z.string().default('3000'),

  // ─── PostgreSQL — full URL preferred in production; fallback to discrete vars
  // DATABASE_URL takes precedence when present.
  DATABASE_URL: z
    .string()
    .url('DATABASE_URL must be a valid postgres:// connection URL')
    .optional(),

  // Discrete vars (used when DATABASE_URL is absent, e.g. local dev)
  DB_HOST:     z.string().default('localhost'),
  DB_PORT:     z.string().default('5432'),
  DB_NAME:     z.string().default('retail_saas'),
  DB_USER:     z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),
  DB_SSL:      z.enum(['true', 'false']).default('false'),

  // ─── Redis (general purpose — idempotency, rate-limit, cache) ─────────────
  REDIS_URL: z
    .string()
    .url('REDIS_URL must be a valid redis:// or rediss:// URL')
    .default('redis://localhost:6379'),

  // ─── BullMQ (dedicated queue connection — may point to a different instance)
  BULLMQ_REDIS_URL: z
    .string()
    .url('BULLMQ_REDIS_URL must be a valid redis:// or rediss:// URL')
    .default('redis://localhost:6379'),

  // ─── JWT (asymmetric RS256) ────────────────────────────────────────────────
  JWT_PRIVATE_KEY: z
    .string()
    .min(1, 'JWT_PRIVATE_KEY is required — set to PEM-encoded RSA private key'),
  JWT_PUBLIC_KEY: z
    .string()
    .min(1, 'JWT_PUBLIC_KEY is required — set to PEM-encoded RSA public key'),
  JWT_EXPIRY: z.string().default('1h'),

  // ─── Refresh token (symmetric HMAC fallback for refresh tokens only) ───────
  REFRESH_TOKEN_SECRET:    z.string().min(32, 'REFRESH_TOKEN_SECRET must be at least 32 chars').optional(),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

  // ─── Tenant / Auth header names (configurable for proxy compatibility) ──────
  TENANT_CONTEXT_HEADER: z.string().default('x-tenant-id'),
  AUTH_HEADER:           z.string().default('authorization'),

  // ─── Twilio WhatsApp Business API ─────────────────────────────────────────
  WHATSAPP_ACCOUNT_SID:  z.string().optional(),
  WHATSAPP_AUTH_TOKEN:   z.string().optional(),
  WHATSAPP_FROM_NUMBER:  z.string().optional(),
});

// ─── Derived type — import this in service code for typed access ──────────────
export type Env = z.infer<typeof envSchema>;

// ─── Parse and validate at module load time ───────────────────────────────────
function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error(
      `\n[config] ❌ Environment validation failed:\n${formatted}\n` +
      `\n  Ensure all required variables are set in your .env file or deployment config.\n`,
    );
    process.exit(1);
  }

  return result.data;
}

/**
 * Validated, typed environment object.
 * Import this — never access process.env directly in service code.
 *
 * @example
 * import { env } from '@retail/config';
 * const port = Number(env.PORT);
 */
export const env: Env = validateEnv();
