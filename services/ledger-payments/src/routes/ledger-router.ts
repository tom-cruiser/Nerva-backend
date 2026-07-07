import { Router } from 'express';

/**
 * Ledger routes — FIFO credit + MoMo reconciliation stubs.
 * Full implementation in skill-3 (momo-ledger) pass.
 */
const ledgerRouter = Router();

ledgerRouter.get('/customers/:customerId/balance', (_req, res) => {
  res.status(501).json({ error: 'Not yet implemented', code: 'INVALID_REQUEST' });
});

ledgerRouter.post('/customers/:customerId/credit', (_req, res) => {
  res.status(501).json({ error: 'Not yet implemented', code: 'INVALID_REQUEST' });
});

ledgerRouter.post('/payments/momo', (_req, res) => {
  res.status(501).json({ error: 'Not yet implemented', code: 'INVALID_REQUEST' });
});

export { ledgerRouter };
