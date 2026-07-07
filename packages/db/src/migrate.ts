/**
 * Versioned migration runner.
 *
 * Tracks applied migrations in the `schema_migrations` table.
 * Migrations are applied in filename-sorted order inside /migrations/.
 * Each migration runs inside its own BEGIN/COMMIT block under READ COMMITTED.
 * A failed migration rolls back and halts — later migrations are NOT attempted.
 *
 * Usage:
 *   npm run migrate                   — apply all pending migrations
 *   npm run migrate -- --rollback     — execute the matching *_rollback.sql
 *   npm run migrate -- --dry-run      — print pending migrations without running
 */
import 'dotenv/config';
import * as fs   from 'fs';
import * as path from 'path';
import { getClient, closePool } from './pool';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const ROLLBACK_FLAG  = process.argv.includes('--rollback');
const DRY_RUN_FLAG   = process.argv.includes('--dry-run');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureMigrationsTable(): Promise<void> {
  const client = await getClient();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id           SERIAL      PRIMARY KEY,
        filename     TEXT        NOT NULL UNIQUE,
        applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const client = await getClient();
  try {
    const result = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY id ASC',
    );
    return new Set(result.rows.map((r) => r.filename));
  } finally {
    client.release();
  }
}

function getMigrationFiles(rollback: boolean): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => {
      if (rollback) return f.endsWith('_rollback.sql');
      return f.match(/^\d+_/u) && f.endsWith('.sql') && !f.endsWith('_rollback.sql');
    })
    .sort();
  return files;
}

async function applyMigration(filename: string): Promise<void> {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sql      = fs.readFileSync(filePath, 'utf-8');

  const client = await getClient();
  try {
    // READ COMMITTED isolation — per skill-1 multi-table mutation rules
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await client.query(sql);

    // Record the migration (not recorded for rollbacks — they reverse the state)
    if (!ROLLBACK_FLAG) {
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename],
      );
    }

    await client.query('COMMIT');
    console.log(`[migrate] ✓ Applied: ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[migrate] ✗ Failed: ${filename}`, err);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  if (ROLLBACK_FLAG) {
    // Rollback mode — execute the rollback script (no migration tracking)
    const rollbacks = getMigrationFiles(true);
    if (rollbacks.length === 0) {
      console.log('[migrate] No rollback scripts found.');
      return;
    }
    for (const file of rollbacks.reverse()) {
      if (DRY_RUN_FLAG) { console.log(`[migrate] (dry-run) Would rollback: ${file}`); continue; }
      await applyMigration(file);
    }
    return;
  }

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files   = getMigrationFiles(false);
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log('[migrate] ✓ All migrations are up to date.');
    return;
  }

  console.log(`[migrate] ${pending.length} pending migration(s):`);
  pending.forEach((f) => console.log(`  • ${f}`));

  if (DRY_RUN_FLAG) {
    console.log('[migrate] Dry-run mode — no changes applied.');
    return;
  }

  for (const file of pending) {
    await applyMigration(file);
  }

  console.log('[migrate] ✓ All pending migrations applied successfully.');
}

run()
  .catch((err: unknown) => {
    console.error('[migrate] Fatal error', err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
