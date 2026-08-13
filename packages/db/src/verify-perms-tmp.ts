import { getClient, closePool } from './pool';

async function main() {
  const client = await getClient();
  try {
    const rows = await client.query(
      `SELECT id, tenant_id, email, role, is_active, permissions, updated_at
       FROM users
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 20`,
    );
    console.log(JSON.stringify(rows.rows, null, 2));
  } finally {
    client.release();
    await closePool();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
