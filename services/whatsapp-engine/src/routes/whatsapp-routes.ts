// services/whatsapp-engine/src/routes/whatsapp-routes.ts
import { Router } from 'express';
import {
  createSession,
  getSession,
  sendMessageFrom,
  sendBulkMessages,
  destroySession,
  listSessions,
  getSessionStats,
  checkSessionHealth,
} from '../lib/whatsapp-client';
import { getTenantContext, Errors, ApiError, requireSuperadmin } from '@retail/middleware';

const whatsappRouter = Router();

// ============================================
// Session Management Routes
// ============================================

// POST /connect - explicitly start (or resume) this tenant's WhatsApp session.
// Call this once when the user clicks "Connect WhatsApp"; then poll /status.
whatsappRouter.post('/connect', async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required'));
  }

  try {
    const state = getSession(ctx.tenantId) ?? createSession(ctx.tenantId);
    res.json({
      success: true,
      status: state.status,
      qr: state.status === 'AUTHENTICATING' ? state.qr : undefined,
      tenantId: ctx.tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[whatsapp] Connect error for ${ctx.tenantId}:`, err);
    next(new ApiError(err.message || 'Failed to connect to WhatsApp', 'CONNECT_FAILED', 500));
  }
});

// GET /status - poll THIS tenant's connection status / QR.
whatsappRouter.get('/status', async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required to check WhatsApp status'));
  }

  try {
    const state = getSession(ctx.tenantId);
    
    // Check if session exists but is dead
    let healthStatus = 'unknown';
    if (state && state.status === 'READY') {
      const isHealthy = await checkSessionHealth(ctx.tenantId);
      healthStatus = isHealthy ? 'healthy' : 'unhealthy';
      
      // If unhealthy, mark as disconnected
      if (!isHealthy) {
        state.status = 'DISCONNECTED';
      }
    }

    res.json({
      success: true,
      status: state?.status ?? 'DISCONNECTED',
      qr: state?.status === 'AUTHENTICATING' ? state.qr : undefined,
      health: healthStatus,
      messageCount: state?.messageCount || 0,
      lastActivity: state?.lastActivity?.toISOString(),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[whatsapp] Status error for ${ctx.tenantId}:`, err);
    next(new ApiError(err.message || 'Failed to get status', 'STATUS_FAILED', 500));
  }
});

// ============================================
// Messaging Routes
// ============================================

// POST /send - Send a WhatsApp message from THIS tenant's connected number
whatsappRouter.post('/send', async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required to send messages'));
  }

  const { number, message } = req.body as { number?: string; message?: string };
  if (!number || !message) {
    return next(Errors.invalidRequest('number and message are required'));
  }

  try {
    console.log(`[whatsapp] Sending message from tenant ${ctx.tenantId} to ${number}`);
    const response = await sendMessageFrom(ctx.tenantId, number, message);
    
    res.json({ 
      success: true, 
      messageId: response?.id?._serialized ?? response?.id ?? null,
      recipient: number,
      tenantId: ctx.tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[whatsapp] Send error for ${ctx.tenantId}:`, err);
    const errorMsg = err instanceof Error ? err.message : 'Failed to send WhatsApp message';
    
    // Categorize errors for better response
    if (errorMsg.includes('not registered on WhatsApp')) {
      return next(Errors.invalidRequest(errorMsg));
    }
    if (errorMsg.includes('Failed to resolve WhatsApp user LID')) {
      return next(Errors.invalidRequest(errorMsg));
    }
    if (errorMsg.includes('Rate limit')) {
      return next(Errors.tooManyRequests(errorMsg));
    }
    if (errorMsg.includes('not connected') || errorMsg.includes('not ready')) {
      return next(Errors.serviceUnavailable(errorMsg));
    }
    
    next(new ApiError(errorMsg, 'SEND_FAILED', 500));
  }
});

// POST /send-bulk - Send bulk messages to multiple recipients
whatsappRouter.post('/send-bulk', async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required to send messages'));
  }

  const { recipients, message, options } = req.body as { 
    recipients?: string[]; 
    message?: string;
    options?: {
      waitForAll?: boolean;
      delayBetween?: number;
      chunkSize?: number;
      customMessages?: Record<string, string>;
    };
  };

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return next(Errors.invalidRequest('recipients must be a non-empty array'));
  }

  if (!message) {
    return next(Errors.invalidRequest('message is required'));
  }

  try {
    console.log(`[whatsapp] Sending bulk message from tenant ${ctx.tenantId} to ${recipients.length} recipients`);
    
    const result = await sendBulkMessages(
      ctx.tenantId,
      recipients,
      message,
      {
        waitForAll: options?.waitForAll ?? true,
        delayBetween: options?.delayBetween ?? 1000,
        chunkSize: options?.chunkSize ?? 10,
        customMessages: options?.customMessages || {},
        onProgress: (current, total, tenantId) => {
          console.log(`[whatsapp:${tenantId}] Bulk progress: ${current}/${total}`);
        }
      }
    );

    res.json({
      success: true,
      summary: {
        total: result.total,
        successful: result.successful,
        failed: result.failed,
      },
      results: result.results,
      errors: result.errors,
      tenantId: ctx.tenantId,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    });
  } catch (err: any) {
    console.error(`[whatsapp] Bulk send error for ${ctx.tenantId}:`, err);
    const errorMsg = err instanceof Error ? err.message : 'Failed to send bulk messages';
    next(new ApiError(errorMsg, 'BULK_SEND_FAILED', 500));
  }
});

// ============================================
// Session Management Routes
// ============================================

// POST /logout - Logout and tear down THIS tenant's WhatsApp session
whatsappRouter.post('/logout', async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required'));
  }

  try {
    await destroySession(ctx.tenantId);
    res.json({ 
      success: true, 
      status: 'Logged out',
      tenantId: ctx.tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[whatsapp] Logout error for ${ctx.tenantId}:`, err);
    const errorMsg = err instanceof Error ? err.message : 'Failed to logout from WhatsApp';
    next(new ApiError(errorMsg, 'LOGOUT_FAILED', 500));
  }
});

// ============================================
// Admin Routes (System-wide, requires admin privileges)
// ============================================

// GET /admin/sessions - List all active sessions (Admin only)
whatsappRouter.get('/admin/sessions', requireSuperadmin(), async (req, res, next) => {
  try {
    const sessions = listSessions();
    const stats = getSessionStats();
    
    res.json({
      success: true,
      stats,
      sessions: sessions.map(s => ({
        tenantId: s.tenantId,
        status: s.status,
        messageCount: s.messageCount,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        lastError: s.lastError,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[whatsapp] Admin sessions error:', err);
    next(new ApiError(err.message || 'Failed to get sessions', 'ADMIN_ERROR', 500));
  }
});

// POST /admin/cleanup - Manually trigger session cleanup (Admin only)
whatsappRouter.post('/admin/cleanup', requireSuperadmin(), async (req, res, next) => {
  try {
    const { cleanupDeadSessions } = await import('../lib/whatsapp-client');
    await cleanupDeadSessions();
    
    res.json({
      success: true,
      message: 'Cleanup completed',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[whatsapp] Admin cleanup error:', err);
    next(new ApiError(err.message || 'Failed to cleanup sessions', 'ADMIN_ERROR', 500));
  }
});

// POST /admin/shutdown - Shutdown all sessions (Admin only)
whatsappRouter.post('/admin/shutdown', requireSuperadmin(), async (req, res, next) => {
  try {
    const { shutdownAllSessions } = await import('../lib/whatsapp-client');
    await shutdownAllSessions();
    
    res.json({
      success: true,
      message: 'All sessions shut down',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[whatsapp] Admin shutdown error:', err);
    next(new ApiError(err.message || 'Failed to shutdown sessions', 'ADMIN_ERROR', 500));
  }
});

// ============================================
// Public Status Route (No Auth Required)
// ============================================

// GET /public-status - Public status endpoint for health checks
whatsappRouter.get('/public-status', async (_req, res) => {
  try {
    const stats = getSessionStats();
    res.json({
      success: true,
      service: 'whatsapp-engine',
      status: 'operational',
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[whatsapp] Public status error:', err);
    res.status(500).json({
      success: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

export { whatsappRouter };