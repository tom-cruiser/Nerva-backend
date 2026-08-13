import { getClient, closePool } from './pool';

async function main() {
  const client = await getClient();
  try {
    const rows = await client.query(
      `SELECT id, tenant_id, entity_type, entity_id, action, old_values, new_values, created_at
       FROM audit_logs
       WHERE entity_type = 'user'
       ORDER BY created_at DESC
       LIMIT 15`,
    );
    console.log(JSON.stringify(rows.rows, null, 2));
  } finally {
    client.release();
    await closePool();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
