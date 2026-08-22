import { Router, Request, Response, NextFunction } from 'express';
import { getClient, query } from '@retail/db';
import { publishRealtimeEvent, tenantRoom, PLATFORM_STAFF_ROOM } from '@retail/redis';
import { requireAnyPermission, getTenantContext, Errors } from '@retail/middleware';

/**
 * Super Admin side of the tenant ↔ support chat (see services/auth-tenant's
 * support-handler.ts for the tenant side, and packages/db's
 * 027_support_chat.sql for the schema). Reads are open to any platform
 * role (support/billing/superadmin) — same split as the rest of the newer
 * routers in this service (settings-router.ts, subscriptions-router.ts).
 */

const router = Router();

const anyPlatformRole = requireAnyPermission('platform:support', 'platform:billing', 'superadmin:access');

interface SupportThreadRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  status: 'OPEN' | 'CLOSED';
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
}

interface SupportMessageRow {
  id: string;
  tenant_id: string;
  sender_type: 'TENANT' | 'STAFF';
  sender_user_id: string;
  sender_email: string | null;
  body: string;
  created_at: string;
}

function toWire(row: SupportMessageRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    senderEmail: row.sender_email,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * GET /api/v1/superadmin/support/threads
 * Every tenant that has messaged support at least once, most recently
 * active first. `unread_count` is derived from staff_last_read_at, not a
 * counter column, so it can't drift from the actual message history.
 */
router.get(
  '/support/threads',
  anyPlatformRole,
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await query<SupportThreadRow>(
        `SELECT t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
                st.status, st.last_message_at, st.last_message_preview,
                (SELECT COUNT(*)::int FROM support_messages m
                  WHERE m.tenant_id = t.id
                    AND m.sender_type = 'TENANT'
                    AND m.created_at > st.staff_last_read_at
                ) AS unread_count
         FROM support_threads st
         JOIN tenants t ON t.id = st.tenant_id
         ORDER BY st.last_message_at DESC NULLS LAST`,
      );
      res.status(200).json({ threads: result.rows });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/superadmin/support/threads/:tenantId/messages
 * Opening a thread marks it read on the staff side.
 */
router.get(
  '/support/threads/:tenantId/messages',
  anyPlatformRole,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = req.params;

      const tenantCheck = await query<{ id: string }>('SELECT id FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
      if (tenantCheck.rows.length === 0) {
        next(Errors.notFound('Tenant not found'));
        return;
      }

      const messagesResult = await query<SupportMessageRow>(
        `SELECT id, tenant_id, sender_type, sender_user_id, sender_email, body, created_at
         FROM support_messages
         WHERE tenant_id = $1
         ORDER BY created_at ASC`,
        [tenantId],
      );

      await query(
        `INSERT INTO support_threads (tenant_id, staff_last_read_at)
         VALUES ($1, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET staff_last_read_at = NOW()`,
        [tenantId],
      );

      res.status(200).json({ messages: messagesResult.rows.map(toWire) });
    } catch (err) {
      next(err);
    }
  },
);

interface ReplyBody {
  body?: string;
}

/**
 * POST /api/v1/superadmin/support/threads/:tenantId/messages
 * Only replies to a thread that already exists — a Super Admin can't
 * cold-start a chat with a tenant that has never messaged support.
 */
router.post(
  '/support/threads/:tenantId/messages',
  anyPlatformRole,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { tenantId } = req.params;
      const body = (req.body as ReplyBody).body?.trim();
      if (!body) {
        next(Errors.invalidRequest('body is required'));
        return;
      }
      if (body.length > 4000) {
        next(Errors.invalidRequest('body must be 4000 characters or fewer'));
        return;
      }

      const client = await getClient();
      let message: SupportMessageRow;
      try {
        await client.query('BEGIN');

        const threadCheck = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM support_threads WHERE tenant_id = $1 LIMIT 1',
          [tenantId],
        );
        if (threadCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          next(Errors.notFound('No support thread for this tenant yet — the tenant has to message first'));
          return;
        }

        const inserted = await client.query<SupportMessageRow>(
          `INSERT INTO support_messages (tenant_id, sender_type, sender_user_id, sender_email, body)
           VALUES ($1, 'STAFF', $2, $3, $4)
           RETURNING id, tenant_id, sender_type, sender_user_id, sender_email, body, created_at`,
          [tenantId, ctx.userId, ctx.email, body],
        );
        message = inserted.rows[0];

        await client.query(
          `UPDATE support_threads
             SET last_message_at = NOW(), last_message_preview = $2, updated_at = NOW(), staff_last_read_at = NOW()
           WHERE tenant_id = $1`,
          [tenantId, body.slice(0, 200)],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const wire = toWire(message);
      await publishRealtimeEvent(tenantRoom(tenantId), 'support:message_created', wire);
      await publishRealtimeEvent(PLATFORM_STAFF_ROOM, 'support:message_created', wire);

      res.status(201).json(wire);
    } catch (err) {
      next(err);
    }
  },
);

export { router as supportRouter };
