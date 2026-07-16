import { Router } from 'express';
import { clientState, sendMessage, client } from '../lib/whatsapp-client'; // Import client

const whatsappRouter = Router();

whatsappRouter.get('/status', (_req, res) => {
  res.json({
    status: clientState.status,
    qr: clientState.qr,
    timestamp: new Date().toISOString(),
  });
});

whatsappRouter.post('/send', async (req, res) => {
  const { number, message } = req.body as { number?: string; message?: string };
  if (!number || !message) {
    res.status(400).json({ error: 'Missing fields' });
    return;
  }

  try {
    const response = await sendMessage(number, message);
    res.json({ success: true, messageId: response.id._serialized });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Send failed' });
  }
});

whatsappRouter.post('/logout', async (_req, res) => {
  try {
    await client.logout(); // Explicitly logout from WhatsApp
    clientState.status = 'DISCONNECTED';
    clientState.qr = '';
    res.json({ success: true, status: 'Logged out' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to logout' });
  }
});

export { whatsappRouter };