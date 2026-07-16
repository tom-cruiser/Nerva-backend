import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import runPendingMigrations from './autoMigrate';

/**
 * Singleton PostgreSQL connection pool.
 *
 * Connection source priority:
 *   1. DATABASE_URL — full postgres:// connection string (production / PaaS)
 *   2. Discrete DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD (local dev)
 *
 * Pool sizing rationale:
 *   max: 20 — 5 services × 20 = 100, matching Postgres 15 default max_connections.
 *   idleTimeoutMillis: 30_000 — reclaim idle connections under bursty load.
 *   connectionTimeoutMillis: 5_000 — fail fast; circuit-breaker sits above this.
 */
const databaseUrl = process.env['DATABASE_URL'];

/**
 * Resolve the pg `ssl` option from DB_SSL:
 *   'true'      → TLS with certificate verification (production default)
 *   'no-verify' → TLS without verification (Supabase pooler w/o supplied CA)
 *   'false'/unset → no TLS
 */
function resolveSsl(): false | { rejectUnauthorized: boolean } {
  switch (process.env['DB_SSL']) {
    case 'true':      return { rejectUnauthorized: true };
    case 'no-verify': return { rejectUnauthorized: false };
    default:          return false;
  }
}

const pool = databaseUrl
  ? new Pool({
      connectionString:        databaseUrl,
      max:                     20,
      idleTimeoutMillis:       30_000,
      connectionTimeoutMillis: 5_000,
      ssl: resolveSsl(),
    })
  : new Pool({
      host:                    process.env['DB_HOST']     ?? 'localhost',
      port:                    Number(process.env['DB_PORT'] ?? 5432),
      database:                process.env['DB_NAME']     ?? 'retail_saas',
      user:                    process.env['DB_USER'],
      password:                process.env['DB_PASSWORD'],
      max:                     20,
      idleTimeoutMillis:       30_000,
      connectionTimeoutMillis: 5_000,
      ssl: resolveSsl(),
    });

pool.on('error', (err: Error) => {
  console.error('[db:pool] Unexpected idle client error', err.message);
});

/**
 * Execute a single parameterised query from the shared pool.
 */
export async function query<T extends QueryResultRow>(
  sql:     string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}

/**
 * Acquire a dedicated client for multi-statement transactions.
 * Callers MUST release the client in a finally block.
 *
 * @example
 * const client = await getClient();
 * try {
 *   await client.query('BEGIN');
 *   // ...mutations...
 *   await client.query('COMMIT');
 * } catch (err) {
 *   await client.query('ROLLBACK');
 *   throw err;
 * } finally {
 *   client.release();
 * }
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// Eager auto-migration on first pool import.
//
// OFF by default: with a shared database, every booting service would otherwise
// race the same DDL (and the `npm run migrate` CLI), causing errors like
// "duplicate key ... pg_extension_name_index". Apply migrations once out-of-band
// via `npm run migrate`. Opt in per-process with DB_AUTO_MIGRATE=true (e.g. a
// single designated migrator, or local dev convenience). Never in tests.
if (process.env['DB_AUTO_MIGRATE'] === 'true' && process.env['NODE_ENV'] !== 'test') {
  (async () => {
    try {
      await runPendingMigrations();
    } catch (err) {
      console.error('[db:migrate] Migration failure', err);
      // Do not exit process here — let calling service decide. But log prominently.
    }
  })();
}

export default pool;
