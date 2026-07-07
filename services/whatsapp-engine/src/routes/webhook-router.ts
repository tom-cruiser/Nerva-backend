import { Router } from 'express';

/**
 * WhatsApp webhook stubs — Twilio bridge and 8 PM cron digest
 * implemented in skill-3/4 pass.
 */
const webhookRouter = Router();

webhookRouter.post('/status', (_req, res) => {
  // Twilio delivery status callbacks
  res.status(200).send('');
});

export { webhookRouter };
