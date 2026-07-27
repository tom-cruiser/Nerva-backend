// services/whatsapp-engine/src/app.ts
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { requestId, tenantContextMiddleware, globalErrorHandler, corsMiddleware } from '@retail/middleware';
import { webhookRouter } from './routes/webhook-router';
import { whatsappRouter } from './routes/whatsapp-routes';
import { reportRouter } from './routes/report-routes';
import { 
  getSession, 
  listSessions, 
  getSessionStats,
  startCleanupInterval,
  shutdownAllSessions,
  setMessageHandler
} from './lib/whatsapp-client';
import { closePool } from '@retail/db';

const app = express();

// ============================================
// Middleware
// ============================================

app.use(corsMiddleware);
app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(requestId);
app.use('/api/v1/whatsapp/reports', tenantContextMiddleware, reportRouter);
// Request logging middleware
app.use((req, _res, next) => {
  console.log(`[whatsapp-engine] ${req.method} ${req.path}`, {
    headers: {
      'x-tenant-id': req.headers['x-tenant-id'],
      'authorization': req.headers['authorization'] ? 'present' : 'missing'
    }
  });
  next();
});

// ============================================
// Message Handler for Incoming Messages
// ============================================

// This will be called whenever a message is received
setMessageHandler(async (tenantId: string, msg: any) => {
  console.log(`[whatsapp-engine] Message handler for ${tenantId}:`, {
    from: msg.from,
    body: msg.body?.slice(0, 50),
    type: msg.type
  });

  // Forward to webhook for processing
  try {
    const webhookUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3005}`;
    await fetch(`${webhookUrl}/webhooks/whatsapp/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        message: {
          from: msg.from,
          body: msg.body,
          type: msg.type,
          id: msg.id
        }
      })
    });
  } catch (err) {
    console.error(`[whatsapp-engine] Failed to forward message to webhook:`, err);
  }

  // TODO: Add your custom message processing logic here
  // - Store in database
  // - Auto-reply
  // - Forward to AI service
  // - Trigger business workflows
});

// ============================================
// Health Check (NO AUTH REQUIRED)
// ============================================

app.get('/health', async (_req, res) => {
  try {
    const stats = getSessionStats();
    res.json({ 
      status: 'ok', 
      service: 'whatsapp-engine',
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      sessions: {
        total: stats.total,
        ready: stats.ready,
        authenticating: stats.authenticating,
        failed: stats.failed,
        disconnected: stats.disconnected,
        timeout: stats.timeout
      },
      uptime: process.uptime(),
      ts: new Date().toISOString() 
    });
  } catch (err: any) {
    console.error('[whatsapp-engine] Health check error:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Health check failed',
      ts: new Date().toISOString()
    });
  }
});

// ============================================
// Public Status (Limited - NO AUTH REQUIRED)
// ============================================

app.get('/api/v1/whatsapp/public-status', async (_req, res) => {
  try {
    const stats = getSessionStats();
    const sessions = listSessions().slice(0, 10); // Limit for privacy
    
    res.json({
      success: true,
      status: stats.total > 0 ? 'active' : 'idle',
      stats: {
        total: stats.total,
        ready: stats.ready,
        authenticating: stats.authenticating,
        failed: stats.failed,
        disconnected: stats.disconnected
      },
      recentSessions: sessions.map(s => ({
        tenantId: s.tenantId.slice(0, 8) + '...', // Mask for privacy
        status: s.status,
        messageCount: s.messageCount,
        lastActivity: s.lastActivity?.toISOString()
      })),
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[whatsapp-engine] Public status error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to get status',
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================
// Test Endpoints (Development Only)
// ============================================

if (process.env.NODE_ENV !== 'production') {
  // Test endpoint to send message (NO AUTH, for testing only)
  app.get('/test/send', async (req, res) => {
    try {
      const tenantId = req.query.tenantId as string || 'default';
      const number = req.query.number as string;
      const message = req.query.message as string;
      
      if (!number || !message) {
        return res.status(400).json({
          success: false,
          error: 'number and message query parameters are required'
        });
      }

      console.log(`[test] Sending to ${number} for tenant ${tenantId}: ${message}`);

      // Import dynamically to avoid circular dependencies
      const { sendMessageFrom, getSession, createSession } = await import('./lib/whatsapp-client');
      
      // Ensure session exists
      let state = getSession(tenantId);
      if (!state) {
        state = createSession(tenantId);
      }

      if (state.status !== 'READY') {
        return res.status(503).json({
          success: false,
          error: 'WhatsApp not ready for this tenant',
          status: state.status
        });
      }

      const response = await sendMessageFrom(tenantId, number, message);
      res.json({ 
        success: true, 
        messageId: response?.id?._serialized || response?.id || 'unknown',
        tenantId,
        recipient: number,
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('[test] Error:', err);
      res.status(500).json({ 
        success: false,
        error: err.message || String(err) 
      });
    }
  });

  // Test endpoint to list sessions (NO AUTH, for testing only)
  app.get('/test/sessions', async (_req, res) => {
    try {
      const sessions = listSessions();
      res.json({
        success: true,
        count: sessions.length,
        sessions: sessions.map(s => ({
          tenantId: s.tenantId,
          status: s.status,
          messageCount: s.messageCount,
          lastActivity: s.lastActivity?.toISOString(),
          hasError: !!s.lastError
        })),
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('[test] Sessions error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to list sessions'
      });
    }
  });
}

// ============================================
// Webhook Routes (Public - NO AUTH for webhooks)
// ============================================

app.use('/webhooks/whatsapp', webhookRouter);

// ============================================
// API Routes (Requires Tenant Auth)
// ============================================

app.use('/api/v1/whatsapp', tenantContextMiddleware, whatsappRouter);

// ============================================
// Error Handling
// ============================================

// 404 handler for unmatched routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use(globalErrorHandler);

// ============================================
// Graceful Shutdown
// ============================================

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`[whatsapp-engine] Received ${signal}, starting graceful shutdown...`);
  
  try {
    // Stop accepting new requests (if using a load balancer)
    // For Express, we'll handle this in server.ts
    
    // Cleanup WhatsApp sessions
    console.log('[whatsapp-engine] Shutting down WhatsApp sessions...');
    await shutdownAllSessions();
    
    // Close database connections
    console.log('[whatsapp-engine] Closing database connections...');
    await closePool();
    
    console.log('[whatsapp-engine] Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[whatsapp-engine] Error during shutdown:', err);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================
// Export
// ============================================

export { app };