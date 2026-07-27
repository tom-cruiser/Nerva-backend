// services/whatsapp-engine/src/routes/webhook-routes.ts
import { Router } from 'express';
import { getSession, listSessions } from '../lib/whatsapp-client';
import { getTenantContext } from '@retail/middleware';

const webhookRouter = Router();

// ============================================
// Types
// ============================================

interface WebhookEvent {
  type: 'message_received' | 'message_sent' | 'message_delivered' | 'session_ready' | 'session_disconnected';
  tenantId: string;
  timestamp: string;
  data: any;
}

// In-memory event store (replace with Redis/DB in production)
const webhookEvents: WebhookEvent[] = [];
const MAX_EVENTS = 1000;

// ============================================
// Helpers
// ============================================

function storeEvent(event: WebhookEvent) {
  webhookEvents.push(event);
  if (webhookEvents.length > MAX_EVENTS) {
    webhookEvents.shift();
  }
}

function getEvents(tenantId?: string): WebhookEvent[] {
  if (!tenantId) return webhookEvents.slice(-100);
  return webhookEvents.filter(e => e.tenantId === tenantId).slice(-100);
}

// ============================================
// WhatsApp Webhook Routes
// ============================================

/**
 * POST /incoming - Receive incoming WhatsApp messages
 * This is called by the WhatsApp client when a message arrives
 */
webhookRouter.post('/incoming', async (req, res) => {
  try {
    const { tenantId, message } = req.body;
    
    if (!tenantId || !message) {
      return res.status(400).json({
        success: false,
        error: 'tenantId and message are required'
      });
    }

    console.log(`[webhook] 📩 Incoming message for ${tenantId}:`, {
      from: message.from,
      body: message.body?.slice(0, 50),
      type: message.type
    });

    // Store the event
    storeEvent({
      type: 'message_received',
      tenantId,
      timestamp: new Date().toISOString(),
      data: {
        from: message.from,
        body: message.body,
        type: message.type,
        messageId: message.id?._serialized || message.id
      }
    });

    // TODO: Process the message
    // - Save to database
    // - Forward to AI service
    // - Auto-reply if configured
    // - Trigger business workflows

    res.status(200).json({
      success: true,
      message: 'Webhook processed',
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[webhook] Incoming error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to process incoming message'
    });
  }
});

/**
 * POST /status - Status updates for messages
 * Called when message status changes (sent, delivered, read)
 */
webhookRouter.post('/status', async (req, res) => {
  try {
    const { tenantId, messageId, status, to } = req.body;
    
    if (!tenantId || !messageId) {
      return res.status(400).json({
        success: false,
        error: 'tenantId and messageId are required'
      });
    }

    console.log(`[webhook] 📊 Status update for ${tenantId}:`, {
      messageId,
      status,
      to
    });

    storeEvent({
      type: status === 'delivered' ? 'message_delivered' : 'message_sent',
      tenantId,
      timestamp: new Date().toISOString(),
      data: {
        messageId,
        status,
        to
      }
    });

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[webhook] Status error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to process status update'
    });
  }
});

/**
 * POST /session - Session status updates
 * Called when WhatsApp session connects/disconnects
 */
webhookRouter.post('/session', async (req, res) => {
  try {
    const { tenantId, status, error } = req.body;
    
    if (!tenantId || !status) {
      return res.status(400).json({
        success: false,
        error: 'tenantId and status are required'
      });
    }

    console.log(`[webhook] 🔄 Session update for ${tenantId}:`, {
      status,
      error: error || 'None'
    });

    storeEvent({
      type: status === 'ready' ? 'session_ready' : 'session_disconnected',
      tenantId,
      timestamp: new Date().toISOString(),
      data: {
        status,
        error
      }
    });

    // Notify connected clients via WebSocket if needed
    // This could trigger a real-time UI update

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[webhook] Session error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to process session update'
    });
  }
});

// ============================================
// Webhook Management Routes
// ============================================

/**
 * GET /events - Get webhook events for a tenant
 */
webhookRouter.get('/events', async (req, res) => {
  try {
    let tenantId: string | undefined;
    
    try {
      const ctx = getTenantContext(res);
      tenantId = ctx.tenantId;
    } catch (ctxErr) {
      // If no tenant context, check if admin
      const isAdmin = req.headers['x-admin'] === 'true';
      if (!isAdmin) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
    }

    const events = getEvents(tenantId);
    
    res.json({
      success: true,
      events,
      count: events.length,
      tenantId: tenantId || 'all',
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[webhook] Events error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to get events'
    });
  }
});

/**
 * DELETE /events - Clear webhook events for a tenant
 */
webhookRouter.delete('/events', async (req, res) => {
  try {
    const ctx = getTenantContext(res);
    const tenantId = ctx.tenantId;
    
    const initialCount = webhookEvents.length;
    
    // Remove events for this tenant
    for (let i = webhookEvents.length - 1; i >= 0; i--) {
      if (webhookEvents[i].tenantId === tenantId) {
        webhookEvents.splice(i, 1);
      }
    }
    
    res.json({
      success: true,
      message: `Cleared events for ${tenantId}`,
      removed: initialCount - webhookEvents.length,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[webhook] Clear events error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to clear events'
    });
  }
});

// ============================================
// Digest/Report Routes
// ============================================

/**
 * POST /digest - Daily digest (8 PM cron)
 * Sends a summary of WhatsApp activity
 */
webhookRouter.post('/digest', async (req, res) => {
  try {
    const { tenantId } = req.body;
    
    console.log(`[webhook] 📊 Generating digest for ${tenantId || 'all tenants'}`);

    let sessions = tenantId 
      ? [getSession(tenantId)].filter(Boolean)
      : listSessions();

    const digest = {
      generatedAt: new Date().toISOString(),
      totalTenants: sessions.length,
      tenants: sessions.map(session => ({
        tenantId: session!.tenantId,
        status: session!.status,
        messageCount: session!.messageCount,
        lastActivity: session!.lastActivity,
        // Get today's events for this tenant
        todayEvents: getEvents(session!.tenantId).filter(e => {
          const today = new Date().toDateString();
          return new Date(e.timestamp).toDateString() === today;
        })
      }))
    };

    // Here you would:
    // - Send email to admin
    // - Store in database
    // - Send to Slack/Discord webhook

    res.json({
      success: true,
      digest,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[webhook] Digest error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to generate digest'
    });
  }
});

// ============================================
// Health Check
// ============================================

/**
 * GET /health - Health check for webhook service
 */
webhookRouter.get('/health', async (_req, res) => {
  try {
    const stats = listSessions().reduce((acc, session) => {
      acc[session.status] = (acc[session.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    res.json({
      status: 'healthy',
      service: 'whatsapp-webhook',
      sessions: {
        total: listSessions().length,
        ...stats
      },
      events: webhookEvents.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[webhook] Health error:', err);
    res.status(500).json({
      status: 'unhealthy',
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export { webhookRouter };