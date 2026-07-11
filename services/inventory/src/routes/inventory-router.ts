import { Router } from 'express';
import { getTenantContext } from '@retail/middleware';

/**
 * Inventory routes — CRUD stubs awaiting skill-2 idempotency implementation.
 * Every handler demonstrates the mandatory tenant_id injection pattern.
 */
const inventoryRouter = Router();

// GET /api/v1/inventory/products
inventoryRouter.get('/products', (_req, res) => {
  const ctx = getTenantContext(res); // tenant boundary enforced here
  // TODO: query WHERE tenant_id = ctx.tenantId
  res.status(501).json({ tenantId: ctx.tenantId, error: 'Not yet implemented' });
});

export { inventoryRouter };
