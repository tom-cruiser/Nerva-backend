import * as fs from 'fs';
import * as path from 'path';
import { getClient } from './pool';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Simple migration runner executed at startup.
 * - Scans migrations directory for files matching /^\d+_.*\.sql$/
 * - Uses `migration_meta` table to track applied migrations (filename)
 * - Executes each pending migration inside an explicit transaction
 *   with SET TRANSACTION ISOLATION LEVEL READ COMMITTED
 */
export async function runPendingMigrations(): Promise<void> {
  const client = await getClient();
  try {
    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_meta (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Read migration files — forward migrations only. Explicitly exclude
    // reversal scripts (*_rollback.sql / *_down.sql); otherwise a service boot
    // would apply the schema and then immediately tear it down.
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/u.test(f))
      .filter((f) => !f.endsWith('_rollback.sql') && !f.endsWith('_down.sql'))
      .sort();

    const res = await client.query<{ filename: string }>('SELECT filename FROM migration_meta');
    const applied = new Set(res.rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await client.query(sql);
        await client.query('INSERT INTO migration_meta (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[autoMigrate] Applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[autoMigrate] Failed migration: ${file}`, err);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

export default runPendingMigrations;
