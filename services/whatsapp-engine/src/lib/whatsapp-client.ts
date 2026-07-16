import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import qrcode from 'qrcode';

// State management to expose to our API routes
export const clientState = {
  qr: '',
  status: 'DISCONNECTED' as 'DISCONNECTED' | 'AUTHENTICATING' | 'READY',
};

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Required for some Docker environments
      '--disable-gpu'
    ]
  }
});

// Event: Generate QR Code for the frontend
client.on('qr', async (qr) => {
  console.log('[whatsapp-engine] QR Code generated, please scan.');
  clientState.status = 'AUTHENTICATING';
  clientState.qr = await qrcode.toDataURL(qr);
});

// Event: Client is ready to send messages
client.on('ready', () => {
  console.log('[whatsapp-engine] Client is ready!');
  clientState.status = 'READY';
  clientState.qr = ''; // Clear QR once authenticated
});

// Event: Handle incoming messages (optional: log or auto-reply)
client.on('message', (msg: Message) => {
  console.log(`[whatsapp-engine] New message from ${msg.from}: ${msg.body}`);
});

// Error handling
client.on('auth_failure', (msg) => {
  console.error('[whatsapp-engine] Auth failure:', msg);
  clientState.status = 'DISCONNECTED';
});

export const sendMessage = async (number: string, message: string) => {
  if (clientState.status !== 'READY') {
    throw new Error('WhatsApp client is not ready. Please scan the QR code first.');
  }

  // Format number: must be in 1234567890@c.us format
  const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
  return await client.sendMessage(chatId, message);
};