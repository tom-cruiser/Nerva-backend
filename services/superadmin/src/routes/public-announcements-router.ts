import { Router, Request, Response, NextFunction } from 'express';
import { getClient } from '@retail/db';

// Mounted BEFORE tenant auth (same as the existing /health route) —
// deliberately unauthenticated, so this file must NOT import or use
// getTenantContext / requireSuperadmin / anything auth-related, and must
// never select or leak anything sensitive (created_by, ids of other tables,
// etc.).

const router = Router();

/** Every tenant's frontend polls this, unauthenticated, to render a banner. */
router.get('/announcements/active', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query(
      `SELECT id, message, level, starts_at, ends_at
       FROM platform_announcements
       WHERE active = TRUE
         AND starts_at <= NOW()
         AND (ends_at IS NULL OR ends_at > NOW())
       ORDER BY starts_at DESC`,
    );
    res.json({ announcements: rows.rows });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

export { router as publicAnnouncementsRouter };
