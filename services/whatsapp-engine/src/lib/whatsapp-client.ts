// services/whatsapp-engine/src/lib/whatsapp-client.ts
import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import path from 'path';
// NOTE: an unused `import { redis } from '@retail/redis'` used to live here,
// left over from an unimplemented "multi-instance support" idea — sessions
// are in-process-only today (see the in-memory session map below). Removed
// rather than left as a dangling unused import; re-add if/when multi-instance
// session sharing is actually built.

// ============================================
// Types & Interfaces
// ============================================

export type SessionStatus = 'DISCONNECTED' | 'AUTHENTICATING' | 'READY' | 'FAILED' | 'TIMEOUT';

export interface SessionState {
  tenantId: string;
  qr: string;
  status: SessionStatus;
  client: Client;
  lastError?: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
}

export interface BulkSendOptions {
  waitForAll?: boolean;
  delayBetween?: number; // milliseconds between messages
  chunkSize?: number; // send in chunks
  customMessages?: Record<string, string>; // custom message per recipient
  onProgress?: (current: number, total: number, tenantId: string) => void;
}

export interface BulkSendResult {
  total: number;
  successful: number;
  failed: number;
  results: Array<{
    number: string;
    success: boolean;
    messageId?: string;
    error?: string;
    timestamp: string;
  }>;
  errors: string[];
  tenantId: string;
  startedAt: string;
  completedAt: string;
}

type MessageHandler = (tenantId: string, msg: Message) => void | Promise<void>;

// ============================================
// Configuration
// ============================================

const CONFIG = {
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours
  MAX_MESSAGES_PER_MINUTE: 60,
  MAX_MESSAGES_PER_HOUR: 1000,
  MAX_MESSAGES_PER_DAY: 5000,
  CLEANUP_INTERVAL: 5 * 60 * 1000, // 5 minutes
  BULK_CHUNK_SIZE: 10,
  BULK_DELAY_MS: 1000,
};

// ============================================
// Session Management
// ============================================

// One entry per tenant. If this service ever runs as more than one
// process/instance, move status+qr into Redis/DB and make sure a given
// tenantId is always routed to the same process (sticky sessions), since
// the live puppeteer Client itself can't be shared across processes.
const sessions = new Map<string, SessionState>();
const sessionTimers = new Map<string, NodeJS.Timeout>();
const rateLimiters = new Map<string, { count: number; resetTime: number; dailyCount: number; dailyResetTime: number }>();

let onMessage: MessageHandler = () => {};
export function setMessageHandler(handler: MessageHandler) {
  onMessage = handler;
}

// ============================================
// Logger
// ============================================

const logger = {
  info: (tenantId: string, message: string, ...args: any[]) => {
    console.log(`[whatsapp:${tenantId}] ${message}`, ...args);
  },
  error: (tenantId: string, message: string, ...args: any[]) => {
    console.error(`[whatsapp:${tenantId}] ${message}`, ...args);
  },
  warn: (tenantId: string, message: string, ...args: any[]) => {
    console.warn(`[whatsapp:${tenantId}] ${message}`, ...args);
  },
  debug: (tenantId: string, message: string, ...args: any[]) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[whatsapp:${tenantId}] ${message}`, ...args);
    }
  }
};

// ============================================
// Client Builder
// ============================================

function buildClient(tenantId: string): Client {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: tenantId,
      dataPath: path.join('.wwebjs_auth'),
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });
}

// ============================================
// Session Operations
// ============================================

export function getSession(tenantId: string): SessionState | undefined {
  return sessions.get(tenantId);
}

export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

export function getSessionStats(): { 
  total: number; 
  ready: number; 
  authenticating: number; 
  failed: number; 
  disconnected: number;
  timeout: number;
} {
  const stats = { total: 0, ready: 0, authenticating: 0, failed: 0, disconnected: 0, timeout: 0 };
  
  for (const [, state] of sessions) {
    stats.total++;
    switch (state.status) {
      case 'READY': stats.ready++; break;
      case 'AUTHENTICATING': stats.authenticating++; break;
      case 'FAILED': stats.failed++; break;
      case 'TIMEOUT': stats.timeout++; break;
      case 'DISCONNECTED': stats.disconnected++; break;
    }
  }
  
  return stats;
}

function resetSessionTimeout(tenantId: string) {
  // Clear existing timer
  if (sessionTimers.has(tenantId)) {
    clearTimeout(sessionTimers.get(tenantId));
    sessionTimers.delete(tenantId);
  }
  
  // Set new timer
  const timer = setTimeout(async () => {
    logger.warn(tenantId, 'Session timed out due to inactivity');
    const state = sessions.get(tenantId);
    if (state) {
      state.status = 'TIMEOUT';
      state.lastError = 'Session timed out due to inactivity';
    }
    await destroySession(tenantId).catch(console.error);
  }, CONFIG.SESSION_TIMEOUT);
  
  sessionTimers.set(tenantId, timer);
}

/** Call this when a tenant clicks "Connect WhatsApp". Idempotent. */
export function createSession(tenantId: string): SessionState {
  const existing = sessions.get(tenantId);
  if (existing) {
    // Reset timeout and update last activity
    existing.lastActivity = new Date();
    resetSessionTimeout(tenantId);
    return existing;
  }

  const client = buildClient(tenantId);
  const state: SessionState = { 
    tenantId, 
    qr: '', 
    status: 'DISCONNECTED', 
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0
  };
  sessions.set(tenantId, state);

  logger.info(tenantId, 'Creating new WhatsApp session');

  client.on('qr', async (qr) => {
    logger.info(tenantId, 'QR generated');
    state.status = 'AUTHENTICATING';
    try {
      state.qr = await qrcode.toDataURL(qr);
    } catch (err) {
      logger.error(tenantId, 'Failed to generate QR code:', err);
    }
    // Reset timeout since user is active
    resetSessionTimeout(tenantId);
  });

  client.on('ready', () => {
    logger.info(tenantId, 'Client ready');
    state.status = 'READY';
    state.qr = '';
    state.lastError = undefined;
    state.lastActivity = new Date();
    resetSessionTimeout(tenantId);
  });

  client.on('auth_failure', (msg) => {
    logger.error(tenantId, 'Auth failure:', msg);
    state.status = 'FAILED';
    state.lastError = String(msg);
  });

  client.on('disconnected', (reason) => {
    logger.warn(tenantId, 'Disconnected:', reason);
    state.status = 'DISCONNECTED';
    state.lastError = String(reason);
  });

  client.on('message', (msg: Message) => {
    state.lastActivity = new Date();
    logger.debug(tenantId, `Message from ${msg.from}: ${msg.body}`);
    void onMessage(tenantId, msg);
  });

  client.initialize().catch((err) => {
    logger.error(tenantId, 'Initialize failed:', err);
    state.status = 'FAILED';
    state.lastError = err?.message ?? String(err);
  });

  // Set initial timeout
  resetSessionTimeout(tenantId);

  return state;
}

export async function destroySession(tenantId: string): Promise<void> {
  const state = sessions.get(tenantId);
  if (!state) {
    logger.warn(tenantId, 'Destroy called for non-existent session');
    return;
  }

  logger.info(tenantId, 'Destroying session');

  // Clear timer
  if (sessionTimers.has(tenantId)) {
    clearTimeout(sessionTimers.get(tenantId));
    sessionTimers.delete(tenantId);
  }

  // Clear rate limiter
  rateLimiters.delete(tenantId);

  try {
    await state.client.logout().catch(() => {});
    await state.client.destroy();
  } catch (err) {
    logger.error(tenantId, 'Error during session destruction:', err);
  } finally {
    sessions.delete(tenantId);
    logger.info(tenantId, 'Session destroyed');
  }
}

// ============================================
// Rate Limiting
// ============================================

async function checkRateLimit(tenantId: string): Promise<void> {
  const now = Date.now();
  let limiter = rateLimiters.get(tenantId);
  
  if (!limiter) {
    limiter = { 
      count: 0, 
      resetTime: now + 60000, // 1 minute
      dailyCount: 0,
      dailyResetTime: now + 86400000 // 24 hours
    };
    rateLimiters.set(tenantId, limiter);
  }

  // Reset minute counter if time expired
  if (now > limiter.resetTime) {
    limiter.count = 0;
    limiter.resetTime = now + 60000;
  }

  // Reset daily counter if time expired
  if (now > limiter.dailyResetTime) {
    limiter.dailyCount = 0;
    limiter.dailyResetTime = now + 86400000;
  }

  // Check limits
  if (limiter.count >= CONFIG.MAX_MESSAGES_PER_MINUTE) {
    const waitTime = limiter.resetTime - now;
    throw new Error(`Rate limit exceeded (${CONFIG.MAX_MESSAGES_PER_MINUTE}/min). Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
  }

  if (limiter.dailyCount >= CONFIG.MAX_MESSAGES_PER_DAY) {
    throw new Error(`Daily limit exceeded (${CONFIG.MAX_MESSAGES_PER_DAY}/day). Please try again tomorrow.`);
  }

  // Increment counters
  limiter.count++;
  limiter.dailyCount++;
  rateLimiters.set(tenantId, limiter);
}

// ============================================
// Health Check
// ============================================

export async function checkSessionHealth(tenantId: string): Promise<boolean> {
  const state = sessions.get(tenantId);
  if (!state) return false;
  
  try {
    // Check if client is still connected
    const info = await state.client.info;
    return !!info;
  } catch (err) {
    logger.warn(tenantId, 'Health check failed:', err);
    return false;
  }
}

export async function cleanupDeadSessions(): Promise<void> {
  logger.info('system', 'Running session cleanup...');
  const toRemove: string[] = [];

  for (const [tenantId, state] of sessions) {
    if (state.status === 'TIMEOUT') {
      toRemove.push(tenantId);
      continue;
    }

    if (state.status === 'READY') {
      const isHealthy = await checkSessionHealth(tenantId);
      if (!isHealthy) {
        logger.warn(tenantId, 'Session is dead, marking for cleanup');
        toRemove.push(tenantId);
      }
    }

    // Check for stale sessions (status DISCONNECTED for too long)
    if (state.status === 'DISCONNECTED') {
      const age = Date.now() - state.lastActivity.getTime();
      if (age > CONFIG.SESSION_TIMEOUT) {
        logger.warn(tenantId, 'Stale disconnected session, cleaning up');
        toRemove.push(tenantId);
      }
    }
  }

  for (const tenantId of toRemove) {
    await destroySession(tenantId);
  }

  logger.info('system', `Cleanup complete. Removed ${toRemove.length} sessions.`);
}

// ============================================
// Error Handling
// ============================================

function isLidResolutionError(err: any): boolean {
  const msg = err?.message || String(err);
  return (
    msg.includes('No LID for user') ||
    msg.includes('LID') ||
    msg === 't: t' ||
    msg.includes('Evaluation failed') ||
    msg.includes('ExecutionContext')
  );
}

async function tryResolveLidJid(client: Client, chatId: string): Promise<string | null> {
  try {
    const anyClient = client as any;
    if (typeof anyClient.getContactLidAndPhone !== 'function') return null;
    const resolved = await anyClient.getContactLidAndPhone(chatId);
    const lid = resolved?.[0]?.lid;
    if (!lid) return null;
    return typeof lid === 'string' ? lid : lid._serialized ?? String(lid);
  } catch (resolveErr) {
    logger.warn('system', `LID fallback resolution failed for ${chatId}:`, resolveErr);
    return null;
  }
}

// ============================================
// Send Message
// ============================================

/**
 * Resolves a raw phone number (or an already-`@`-suffixed chatId) to the
 * WhatsApp chatId `sendMessage()` actually needs — the same lookup
 * `sendMessageFrom` does internally, exposed standalone for callers that
 * need to send a SECOND thing (e.g. a PDF attachment) to the same
 * recipient without re-deriving it. Genuinely necessary: passing a raw
 * phone number straight to `client.sendMessage()` fails for LID-based
 * contacts (`...@lid`, not `...@c.us`) — confirmed live, this is exactly
 * why `report-dispatch.ts`'s PDF-attachment step was failing 100% of the
 * time while the text message (which does go through this resolution)
 * sent successfully.
 */
export async function resolveChatId(tenantId: string, number: string): Promise<string> {
  const state = sessions.get(tenantId);
  if (!state || state.status !== 'READY') {
    throw new Error('WhatsApp session not ready');
  }
  if (number.includes('@')) return number;
  const cleaned = number.replace(/\D/g, '');
  const numberId = await state.client.getNumberId(cleaned);
  if (!numberId) {
    throw new Error(`The number ${cleaned} is not registered on WhatsApp.`);
  }
  return numberId._serialized;
}

export async function sendMessageFrom(
  tenantId: string,
  number: string,
  message: string
): Promise<any> {
  const state = sessions.get(tenantId);
  if (!state) {
    throw new Error('No WhatsApp session for this account. Connect WhatsApp first.');
  }
  
  if (state.status !== 'READY') {
    throw new Error('WhatsApp is not connected yet. Please scan the QR code first.');
  }

  // Update last activity
  state.lastActivity = new Date();
  resetSessionTimeout(tenantId);

  // Check rate limits
  await checkRateLimit(tenantId);

  // Clean the number
  const cleaned = number.includes('@') ? number.split('@')[0] : number.replace(/\D/g, '');
  let chatId: string;

  logger.debug(tenantId, `Processing number: ${number} -> cleaned: ${cleaned}`);

  if (number.includes('@')) {
    chatId = number;
  } else {
    try {
      const numberId = await state.client.getNumberId(cleaned);
      if (!numberId) {
        throw new Error(`The number ${cleaned} is not registered on WhatsApp.`);
      }
      chatId = numberId._serialized;
    } catch (err: any) {
      logger.error(tenantId, `Failed to get number ID for ${cleaned}:`, err);
      throw new Error(`Failed to validate number ${cleaned}. Please check the format.`);
    }
  }

  logger.info(tenantId, `Sending message to ${chatId}`);

  // Warm up chat
  try {
    await state.client.getChatById(chatId);
  } catch (chatErr) {
    logger.warn(tenantId, `Chat warm-up failed for ${chatId}:`, chatErr);
    // Non-fatal, continue
  }

  try {
    const result = await state.client.sendMessage(chatId, message);
    state.messageCount++;
    // sendMessage() resolving does NOT mean WhatsApp actually accepted the
    // message — confirmed live: it can resolve with `undefined` (WhatsApp
    // Web's own store never registered the send) or with a Message object
    // whose `ack` is MessageAck.ACK_ERROR (-1), and neither of those throws.
    // A prior version of this code treated "promise resolved" as
    // unconditional success, which is how a report got logged SENT here
    // while never actually reaching the recipient's phone.
    if (!result) {
      logger.error(tenantId, `sendMessage to ${chatId} resolved with no message object — WhatsApp Web did not register the send`);
      throw new Error('WhatsApp did not confirm the message was sent — it may not have been delivered.');
    }
    if (typeof result.ack === 'number' && result.ack < 0) {
      logger.error(tenantId, `sendMessage to ${chatId} returned ack=${result.ack} (ACK_ERROR) — WhatsApp rejected the message`);
      throw new Error('WhatsApp rejected the message (ACK_ERROR) — it was not delivered.');
    }
    logger.info(tenantId, `Message sent successfully to ${chatId} (ack=${result.ack}, Total: ${state.messageCount})`);
    return result;
  } catch (err: any) {
    logger.error(tenantId, `Send failed to ${chatId}:`, err?.message || err);

    if (isLidResolutionError(err)) {
      logger.warn(tenantId, `LID resolution error detected, attempting fallback for ${chatId}`);
      const lidJid = await tryResolveLidJid(state.client, chatId);

      if (lidJid) {
        try {
          logger.info(tenantId, `Retrying with resolved LID JID: ${lidJid}`);
          const result = await state.client.sendMessage(lidJid, message);
          state.messageCount++;
          if (!result || (typeof result.ack === 'number' && result.ack < 0)) {
            throw new Error('WhatsApp did not confirm the retried message was delivered.');
          }
          return result;
        } catch (retryErr: any) {
          logger.error(tenantId, `Retry with LID JID failed:`, retryErr?.message || retryErr);
          throw new Error('Failed to resolve WhatsApp user LID. Please check the contact format.');
        }
      }
      throw new Error('Failed to resolve WhatsApp user LID. Please check the contact format.');
    }
    throw err;
  }
}

// ============================================
// Bulk Send Messages
// ============================================

export async function sendBulkMessages(
  tenantId: string,
  numbers: string[],
  defaultMessage: string,
  options: BulkSendOptions = {}
): Promise<BulkSendResult> {
  const {
    waitForAll = true,
    delayBetween = CONFIG.BULK_DELAY_MS,
    chunkSize = CONFIG.BULK_CHUNK_SIZE,
    customMessages = {},
    onProgress
  } = options;

  const state = sessions.get(tenantId);
  if (!state) {
    throw new Error('No WhatsApp session for this account. Connect WhatsApp first.');
  }
  
  if (state.status !== 'READY') {
    throw new Error('WhatsApp is not connected yet. Please scan the QR code first.');
  }

  // Update last activity
  state.lastActivity = new Date();
  resetSessionTimeout(tenantId);

  // Deduplicate numbers
  const uniqueNumbers = [...new Set(numbers)];
  logger.info(tenantId, `Starting bulk send to ${uniqueNumbers.length} unique recipients`);

  const results: BulkSendResult['results'] = [];
  const errors: string[] = [];
  let successful = 0;
  let failed = 0;
  const startedAt = new Date().toISOString();

  // If not waiting for all, process in background
  if (!waitForAll) {
    // Process in background
    processBulkMessages(tenantId, uniqueNumbers, defaultMessage, customMessages, {
      delayBetween,
      chunkSize,
      onProgress,
      results,
      errors,
      successful,
      failed
    }).catch(err => {
      logger.error(tenantId, 'Background bulk send failed:', err);
    });
    
    return {
      total: uniqueNumbers.length,
      successful: 0,
      failed: 0,
      results: [],
      errors: ['Processing in background'],
      tenantId,
      startedAt,
      completedAt: new Date().toISOString()
    };
  }

  // Process and wait for all
  try {
    const chunks = chunkArray(uniqueNumbers, chunkSize);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.debug(tenantId, `Processing chunk ${i + 1}/${chunks.length} (${chunk.length} numbers)`);
      
      // Send messages in parallel within chunk
      const chunkPromises = chunk.map(async (number) => {
        const message = customMessages[number] || defaultMessage;
        try {
          const result = await sendMessageFrom(tenantId, number, message);
          successful++;
          return {
            number,
            success: true,
            messageId: result?.id?._serialized || result?.id || 'unknown',
            timestamp: new Date().toISOString()
          };
        } catch (err: any) {
          failed++;
          const errorMsg = err.message || 'Unknown error';
          errors.push(`Failed for ${number}: ${errorMsg}`);
          return {
            number,
            success: false,
            error: errorMsg,
            timestamp: new Date().toISOString()
          };
        }
      });

      // Wait for chunk to complete
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);

      // Update progress
      if (onProgress) {
        const completed = Math.min((i + 1) * chunkSize, uniqueNumbers.length);
        onProgress(completed, uniqueNumbers.length, tenantId);
      }

      // Delay between chunks (if not last chunk)
      if (i < chunks.length - 1 && delayBetween > 0) {
        await sleep(delayBetween);
      }
    }
  } catch (err: any) {
    logger.error(tenantId, 'Fatal error in bulk send:', err);
    errors.push(`Fatal error: ${err.message}`);
  }

  return {
    total: uniqueNumbers.length,
    successful,
    failed,
    results,
    errors,
    tenantId,
    startedAt,
    completedAt: new Date().toISOString()
  };
}

/**
 * Process bulk messages in background
 */
async function processBulkMessages(
  tenantId: string,
  numbers: string[],
  defaultMessage: string,
  customMessages: Record<string, string>,
  options: {
    delayBetween: number;
    chunkSize: number;
    onProgress?: (current: number, total: number, tenantId: string) => void;
    results: BulkSendResult['results'];
    errors: string[];
    successful: number;
    failed: number;
  }
) {
  const { delayBetween, chunkSize, onProgress, results, errors } = options;
  const chunks = chunkArray(numbers, chunkSize);
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkPromises = chunk.map(async (number) => {
      const message = customMessages[number] || defaultMessage;
      try {
        const result = await sendMessageFrom(tenantId, number, message);
        options.successful++;
        results.push({
          number,
          success: true,
          messageId: result?.id?._serialized || result?.id || 'unknown',
          timestamp: new Date().toISOString()
        });
      } catch (err: any) {
        const errorMsg = err.message || 'Unknown error';
        options.failed++;
        errors.push(`Failed for ${number}: ${errorMsg}`);
        results.push({
          number,
          success: false,
          error: errorMsg,
          timestamp: new Date().toISOString()
        });
      }
    });

    await Promise.all(chunkPromises);
    
    if (onProgress) {
      const completed = Math.min((i + 1) * chunkSize, numbers.length);
      onProgress(completed, numbers.length, tenantId);
    }
    
    if (i < chunks.length - 1 && delayBetween > 0) {
      await sleep(delayBetween);
    }
  }
}

// ============================================
// Helper Functions
// ============================================

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Cleanup Interval
// ============================================

// Start cleanup interval
let cleanupInterval: NodeJS.Timeout;

export function startCleanupInterval(intervalMs: number = CONFIG.CLEANUP_INTERVAL): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  cleanupInterval = setInterval(() => {
    cleanupDeadSessions().catch(console.error);
  }, intervalMs);
  logger.info('system', `Cleanup interval started (${intervalMs}ms)`);
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    logger.info('system', 'Cleanup interval stopped');
  }
}

// ============================================
// Graceful Shutdown
// ============================================

export async function shutdownAllSessions(): Promise<void> {
  logger.info('system', 'Shutting down all sessions...');
  const promises = [];
  
  for (const [tenantId, state] of sessions) {
    logger.info(tenantId, 'Shutting down...');
    promises.push(
      state.client.destroy().catch(err => 
        logger.error(tenantId, 'Error during shutdown:', err)
      )
    );
  }
  
  await Promise.all(promises);
  sessions.clear();
  sessionTimers.clear();
  rateLimiters.clear();
  
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  
  logger.info('system', 'All sessions shut down');
}

// ============================================
// Export all functions
// ============================================

export default {
  createSession,
  getSession,
  destroySession,
  listSessions,
  getSessionStats,
  sendMessageFrom,
  sendBulkMessages,
  checkSessionHealth,
  cleanupDeadSessions,
  startCleanupInterval,
  stopCleanupInterval,
  shutdownAllSessions,
  setMessageHandler,
};