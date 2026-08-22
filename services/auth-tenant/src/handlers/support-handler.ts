import { Request, Response, NextFunction } from 'express';
import { Errors, getTenantContext } from '@retail/middleware';
import { getClient, query } from '@retail/db';
import { publishRealtimeEvent, tenantRoom, PLATFORM_STAFF_ROOM } from '@retail/redis';

/**
 * Tenant-facing support chat — any signed-in tenant user messaging the
 * Super Admin team, and reading the Super Admin's replies. Deliberately not
 * gated behind a Permission (unlike everything else in this router) —
 * a STAFF cashier locked out of ledger:read/reports:read should still be
 * able to ask for help. Lives here (auth-tenant), not services/superadmin,
 * for the same reason subscription-handler.ts does: this is the tenant's
 * own account-level concern, not a platform-staff operation. See
 * services/superadmin's support-router.ts for the other side of the thread.
 */

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
 * GET /api/v1/auth/support/messages
 * Full thread history for the authenticated tenant, oldest first. Opening
 * this page marks every Staff reply up to now as read (see
 * support_threads.tenant_last_read_at) — the same "viewing the list IS
 * reading it" assumption the rest of this service makes elsewhere.
 */
export async function listSupportMessagesHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);

    const messagesResult = await query<SupportMessageRow>(
      `SELECT id, tenant_id, sender_type, sender_user_id, sender_email, body, created_at
       FROM support_messages
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [ctx.tenantId],
    );

    const threadResult = await query<{ status: 'OPEN' | 'CLOSED' }>(
      `INSERT INTO support_threads (tenant_id, tenant_last_read_at)
       VALUES ($1, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET tenant_last_read_at = NOW()
       RETURNING status`,
      [ctx.tenantId],
    );

    res.status(200).json({
      status: threadResult.rows[0]?.status ?? 'OPEN',
      messages: messagesResult.rows.map(toWire),
    });
  } catch (err) {
    next(err);
  }
}

interface SendSupportMessageBody {
  body?: string;
}

/**
 * POST /api/v1/auth/support/messages
 * Pushed live to:
 *  - tenant:<id>    — a second signed-in staff member of the SAME tenant
 *                     sees the message appear without refreshing.
 *  - platform:staff — every connected Super Admin/support dashboard, so the
 *                      inbox and its unread badge update instantly.
 * See services/realtime/src/socket.ts for how sockets join those rooms.
 */
export async function sendSupportMessageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);
    const body = (req.body as SendSupportMessageBody).body?.trim();
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

      const inserted = await client.query<SupportMessageRow>(
        `INSERT INTO support_messages (tenant_id, sender_type, sender_user_id, sender_email, body)
         VALUES ($1, 'TENANT', $2, $3, $4)
         RETURNING id, tenant_id, sender_type, sender_user_id, sender_email, body, created_at`,
        [ctx.tenantId, ctx.userId, ctx.email, body],
      );
      message = inserted.rows[0];

      // A tenant message re-opens a thread the Super Admin had marked
      // CLOSED, and re-surfaces it at the top of the support inbox.
      await client.query(
        `INSERT INTO support_threads (tenant_id, last_message_at, last_message_preview, updated_at, status)
         VALUES ($1, NOW(), $2, NOW(), 'OPEN')
         ON CONFLICT (tenant_id) DO UPDATE
           SET last_message_at = NOW(), last_message_preview = $2, updated_at = NOW(), status = 'OPEN'`,
        [ctx.tenantId, body.slice(0, 200)],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const wire = toWire(message);
    // Best-effort — publishRealtimeEvent never throws into this handler
    // (see packages/redis/src/realtime.ts), so a Redis blip can't turn a
    // successfully-saved message into a 500.
    await publishRealtimeEvent(tenantRoom(ctx.tenantId), 'support:message_created', wire);
    await publishRealtimeEvent(PLATFORM_STAFF_ROOM, 'support:message_created', wire);

    res.status(201).json(wire);
  } catch (err) {
    next(err);
  }
}
