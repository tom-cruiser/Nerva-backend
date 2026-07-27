// services/whatsapp-engine/src/server.ts
import { env } from '@retail/config';
import { app } from './app';
import { startCleanupInterval, stopCleanupInterval } from './lib/whatsapp-client';

const PORT = Number(env.PORT ?? 3005);

// ============================================
// Start Cleanup Interval
// ============================================

// Clean up stale sessions every 5 minutes
startCleanupInterval(5 * 60 * 1000);

// ============================================
// Start Server
// ============================================

const server = app.listen(PORT, () => {
  console.log(`[whatsapp-engine] 🚀 Server listening on port ${PORT}`);
  console.log(`[whatsapp-engine] 📊 Environment: ${env.NODE_ENV}`);
  console.log(`[whatsapp-engine] 🏥 Health: http://localhost:${PORT}/health`);
  console.log(`[whatsapp-engine] 🔗 Public Status: http://localhost:${PORT}/api/v1/whatsapp/public-status`);
  console.log(`[whatsapp-engine] 📡 Webhook: http://localhost:${PORT}/webhooks/whatsapp`);
  console.log(`[whatsapp-engine] 🔐 API: http://localhost:${PORT}/api/v1/whatsapp`);
  
  if (env.NODE_ENV !== 'production') {
    console.log(`[whatsapp-engine] 🧪 Test Send: http://localhost:${PORT}/test/send?number=+250780000000&message=Hello`);
    console.log(`[whatsapp-engine] 🧪 Test Sessions: http://localhost:${PORT}/test/sessions`);
  }
  
  console.log(`[whatsapp-engine] ✅ WhatsApp Engine ready at ${new Date().toISOString()}`);
});

// ============================================
// Handle Uncaught Errors
// ============================================

process.on('uncaughtException', (err) => {
  console.error('[whatsapp-engine] Uncaught exception:', err);
  // Keep the process running for production, but log heavily
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[whatsapp-engine] Unhandled rejection at:', promise, 'reason:', reason);
  // Keep the process running for production, but log heavily
});

// ============================================
// Export for testing
// ============================================

export { server };