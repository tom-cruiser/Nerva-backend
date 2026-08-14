// services/whatsapp-engine/src/jobs/report-dispatch.ts
import { getClient, query } from '@retail/db';
import { resolveFeatureFlag } from '@retail/middleware';
import { getSession, createSession, sendMessageFrom, resolveChatId } from '../lib/whatsapp-client';
import type { SessionState } from '../lib/whatsapp-client';
import { formatScheduledReportMessage, ScheduledReportSummary } from '../lib/report-formatter';
import { createPOSReportPDF } from '../lib/pdf-generator';

/**
 * Automated WhatsApp Scheduled Reporting Engine (whatsapp-report.md §3).
 *
 * Lives here — not a separate `services/cron` — because the live WhatsApp
 * session (`whatsapp-web.js`'s Puppeteer `Client`) only exists in THIS
 * process's in-memory `sessions` Map (lib/whatsapp-client.ts). Only code
 * running inside this exact process can call sendMessageFrom().
 *
 * Structurally mirrors services/realtime/src/jobs/expiration-check.ts: a
 * standalone exported async function, `FOR UPDATE SKIP LOCKED` on the
 * candidate select (safe against overlapping ticks), one try/catch per
 * tenant so a single failure never aborts the batch.
 *
 * KNOWN LIMITATION (inherited, not introduced here — see whatsapp-client.ts's
 * own comment on `sessions`): if this service ever runs as more than one
 * replica, each replica has its own independent in-memory session map, and
 * node-cron has no leader election — only the replica holding a tenant's
 * live session can actually deliver its scheduled report. Out of scope to
 * fix here; flagged for whoever changes the deployment topology.
 */

interface DueScheduleRow {
  id: string;
  tenant_id: string;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  delivery_time: string; // 'HH:MM:SS'
  timezone: string;
  day_of_week: number | null;
  day_of_month: number | null;
  recipient_phones: string[];
  included_sections: string[];
  last_sent_on: string | null; // 'YYYY-MM-DD' or null
  currency: string;
}

export interface ReportDispatchResult {
  dispatched: string[];
  skipped: string[];
  failed: Array<{ tenantId: string; error: string }>;
}

// ─── Tenant-local time resolution (Intl.DateTimeFormat, no new dependency) ───

interface TenantLocalNow {
  dateStr: string; // 'YYYY-MM-DD'
  minutesSinceMidnight: number;
  weekday: number; // 0=Sunday..6=Saturday
  day: number; // 1-31
  daysInMonth: number;
}

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function tenantLocalNow(timezone: string): TenantLocalNow {
  const now = new Date();
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
  } catch {
    // Unknown/invalid IANA zone stored on the schedule — fall back to UTC
    // rather than throwing and dropping this tenant's dispatch entirely.
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
  }
  const parts = dtf.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Intl with hour12:false can render midnight as '24' in some environments.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();

  return {
    dateStr: `${year}-${month}-${day}`,
    minutesSinceMidnight: hour * 60 + minute,
    weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
    day: Number(day),
    daysInMonth,
  };
}

/** UTC [start, end) window for "today" in the tenant's local calendar day. */
function localDayWindowUtc(timezone: string, dateStr: string): { start: Date; end: Date } {
  const naiveUtc = new Date(`${dateStr}T00:00:00.000Z`);
  const offsetMinutes = getUtcOffsetMinutes(timezone, naiveUtc);
  const start = new Date(naiveUtc.getTime() - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Minutes to ADD to a UTC instant to get local wall-clock time in `timezone`. */
function getUtcOffsetMinutes(timezone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return (asUtc - date.getTime()) / 60_000;
}

// Cron ticks every 15 minutes (`*/15 * * * *`) but a user can configure any
// HH:MM, so matching needs a window, not exact equality.
const TICK_WINDOW_MINUTES = 15;

function isDue(row: DueScheduleRow, local: TenantLocalNow): boolean {
  if (row.last_sent_on === local.dateStr) return false; // already attempted today

  const [h, m] = row.delivery_time.split(':').map(Number);
  const deliveryMinutes = h * 60 + m;
  if (local.minutesSinceMidnight < deliveryMinutes || local.minutesSinceMidnight >= deliveryMinutes + TICK_WINDOW_MINUTES) {
    return false;
  }

  if (row.frequency === 'DAILY') return true;
  if (row.frequency === 'WEEKLY') return row.day_of_week === local.weekday;
  // MONTHLY — clamp to the month's last day (e.g. day_of_month=31 fires on
  // day 30 in a 30-day month).
  const effectiveDay = Math.min(row.day_of_month ?? 1, local.daysInMonth);
  return local.day === effectiveDay;
}

// ─── Today's aggregation (small, purpose-built — not sales-sync's full report) ─

async function computeTodaySummary(tenantId: string, window: { start: Date; end: Date }): Promise<ScheduledReportSummary> {
  const params = [tenantId, window.start.toISOString(), window.end.toISOString()];

  const totalsResult = await query<{ total_sales: string | null; total_orders: string }>(
    `SELECT COALESCE(SUM(total_amount), 0) AS total_sales, COUNT(*) AS total_orders
     FROM sales
     WHERE tenant_id = $1 AND payment_status = 'PAID'
       AND sale_timestamp >= $2 AND sale_timestamp < $3 AND deleted_at IS NULL`,
    params,
  );
  const totalSales = Number(totalsResult.rows[0]?.total_sales ?? 0);
  const totalOrders = Number(totalsResult.rows[0]?.total_orders ?? 0);

  const paymentResult = await query<{ payment_method: string; amount: string; count: string }>(
    `SELECT payment_method, SUM(total_amount) AS amount, COUNT(*) AS count
     FROM sales
     WHERE tenant_id = $1 AND payment_status = 'PAID'
       AND sale_timestamp >= $2 AND sale_timestamp < $3 AND deleted_at IS NULL
     GROUP BY payment_method ORDER BY amount DESC`,
    params,
  );

  const topProductResult = await query<{ name: string | null; product_sku: string; quantity: string; revenue: string }>(
    `SELECT MAX(i.name) AS name, item->>'product_sku' AS product_sku,
            SUM((item->>'quantity')::numeric) AS quantity,
            SUM((item->>'total')::numeric) AS revenue
     FROM sales s
     CROSS JOIN jsonb_array_elements(s.items_sold) item
     LEFT JOIN inventories i ON i.tenant_id = s.tenant_id AND i.product_sku = item->>'product_sku'
     WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
       AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3 AND s.deleted_at IS NULL
     GROUP BY item->>'product_sku'
     ORDER BY revenue DESC LIMIT 1`,
    params,
  );

  const profitResult = await query<{ total_cost: string | null; missing: string }>(
    `SELECT SUM((item->>'quantity')::numeric * COALESCE(i.cost_price, 0)) AS total_cost,
            COUNT(*) FILTER (WHERE i.cost_price IS NULL) AS missing
     FROM sales s
     CROSS JOIN jsonb_array_elements(s.items_sold) item
     LEFT JOIN inventories i ON i.tenant_id = s.tenant_id AND i.product_sku = item->>'product_sku'
     WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
       AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3 AND s.deleted_at IS NULL`,
    params,
  );
  const missingCost = Number(profitResult.rows[0]?.missing ?? 0);
  const netProfit = missingCost > 0 ? null : totalSales - Number(profitResult.rows[0]?.total_cost ?? 0);

  const cashierResult = await query<{ full_name: string | null; worker_tag: string; sales_count: string; revenue: string }>(
    `SELECT MAX(u.full_name) AS full_name, s.worker_tag,
            COUNT(*) AS sales_count, SUM(s.total_amount) AS revenue
     FROM sales s
     LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.worker_tag = s.worker_tag
     WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
       AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3 AND s.deleted_at IS NULL
     GROUP BY s.worker_tag ORDER BY revenue DESC`,
    params,
  );

  const lowStockResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM inventories
     WHERE tenant_id = $1 AND deleted_at IS NULL AND stock_quantity <= reorder_level`,
    [tenantId],
  );

  const top = topProductResult.rows[0];

  return {
    totalSales,
    totalOrders,
    paymentMethods: paymentResult.rows.map((r) => ({
      method: r.payment_method, amount: Number(r.amount), count: Number(r.count),
    })),
    topProduct: top ? { name: top.name ?? top.product_sku, quantity: Number(top.quantity), revenue: Number(top.revenue) } : null,
    lowStockCount: Number(lowStockResult.rows[0]?.count ?? 0),
    netProfit,
    cashierPerformance: cashierResult.rows.map((r) => ({
      fullName: r.full_name ?? r.worker_tag, salesCount: Number(r.sales_count), revenue: Number(r.revenue),
    })),
  };
}

// ─── Dispatch logging ─────────────────────────────────────────────────────────

async function logDispatch(tenantId: string, phone: string, status: 'SENT' | 'FAILED', errorDetails: string | null): Promise<void> {
  await query(
    `INSERT INTO whatsapp_report_logs (tenant_id, recipient_phone, status, error_details) VALUES ($1, $2, $3, $4)`,
    [tenantId, phone, status, errorDetails],
  ).catch((err) => console.error('[whatsapp-engine:report-dispatch] Failed to write dispatch log', err));
}

// ─── Session bootstrap ────────────────────────────────────────────────────────

/**
 * Neither sendMessageFrom() nor sendPOSReport() ever calls createSession() —
 * only the browser-triggered POST /connect does, and nothing rehydrates
 * `sessions` on process boot. A cron job has no human to click "connect",
 * so it must do this itself: reuse an existing session or start one (which
 * silently resumes via LocalAuth's persisted credentials if this tenant has
 * linked before), then wait for it to become READY.
 */
async function waitForSessionReady(tenantId: string, timeoutMs: number): Promise<SessionState | undefined> {
  let state = getSession(tenantId) ?? createSession(tenantId);
  const deadline = Date.now() + timeoutMs;
  while (state.status !== 'READY' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = getSession(tenantId) ?? state;
  }
  return state;
}

async function sendBestEffortPdf(tenantId: string, recipients: string[], dateStr: string, summary: ScheduledReportSummary): Promise<void> {
  try {
    const state = getSession(tenantId);
    if (!state || state.status !== 'READY') return;
    const pdfBuffer = await createPOSReportPDF(tenantId, dateStr, 'daily', {
      totalSales: summary.totalSales,
      totalOrders: summary.totalOrders,
      averageOrderValue: summary.totalOrders > 0 ? summary.totalSales / summary.totalOrders : 0,
      topSellingProducts: summary.topProduct ? [summary.topProduct] : [],
      revenueByCategory: [],
      paymentMethods: summary.paymentMethods,
      hourlySales: [],
    });
    const { MessageMedia } = await import('whatsapp-web.js');
    const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), `report_${dateStr}.pdf`);
    for (const phone of recipients) {
      // Confirmed live: passing the raw phone number straight to
      // sendMessage() fails 100% of the time for LID-based contacts
      // (chatId like "...@lid", not "...@c.us") — resolveChatId() does the
      // same getNumberId() lookup sendMessageFrom() already uses for the
      // text message, so the PDF goes to the same resolved chat.
      try {
        const chatId = await resolveChatId(tenantId, phone);
        await state.client.sendMessage(chatId, media);
      } catch (err: unknown) {
        console.error(`[whatsapp-engine:report-dispatch] PDF attach failed for ${phone}`, err);
      }
    }
  } catch (err) {
    console.error('[whatsapp-engine:report-dispatch] PDF generation failed', err);
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runScheduledReportDispatch(): Promise<ReportDispatchResult> {
  const dispatched: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ tenantId: string; error: string }> = [];

  const listClient = await getClient();
  let candidates: DueScheduleRow[];
  try {
    const result = await listClient.query<DueScheduleRow>(
      `SELECT wrs.id, wrs.tenant_id, wrs.frequency, wrs.delivery_time::text, wrs.timezone,
              wrs.day_of_week, wrs.day_of_month, wrs.recipient_phones, wrs.included_sections,
              wrs.last_sent_on::text, t.currency
       FROM whatsapp_report_schedules wrs
       JOIN tenants t ON t.id = wrs.tenant_id AND t.status = 'ACTIVE'
       WHERE wrs.enabled = TRUE
       FOR UPDATE OF wrs SKIP LOCKED`,
    );
    candidates = result.rows;
  } finally {
    listClient.release();
  }

  for (const row of candidates) {
    const local = tenantLocalNow(row.timezone);
    if (!isDue(row, local)) {
      skipped.push(row.tenant_id);
      continue;
    }

    try {
      const hasFlag = await resolveFeatureFlag(row.tenant_id, 'whatsapp_reporting');
      if (!hasFlag) {
        // Mark attempted today so a tenant without the plan feature isn't
        // re-evaluated every 15 minutes for the rest of the day.
        await query(`UPDATE whatsapp_report_schedules SET last_sent_on = $2 WHERE id = $1`, [row.id, local.dateStr]);
        skipped.push(row.tenant_id);
        continue;
      }

      const window = localDayWindowUtc(row.timezone, local.dateStr);
      const summary = await computeTodaySummary(row.tenant_id, window);
      const message = formatScheduledReportMessage(summary, row.included_sections, row.currency, local.dateStr);

      const state = await waitForSessionReady(row.tenant_id, 25_000);

      if (!state || state.status !== 'READY') {
        const reason = state?.status === 'AUTHENTICATING'
          ? 'WhatsApp session requires re-authentication — visit the WhatsApp page to reconnect'
          : 'WhatsApp session is not connected';
        for (const phone of row.recipient_phones) {
          await logDispatch(row.tenant_id, phone, 'FAILED', reason);
        }
      } else {
        for (const phone of row.recipient_phones) {
          try {
            await sendMessageFrom(row.tenant_id, phone, message);
            await logDispatch(row.tenant_id, phone, 'SENT', null);
          } catch (sendErr) {
            await logDispatch(row.tenant_id, phone, 'FAILED', sendErr instanceof Error ? sendErr.message : String(sendErr));
          }
        }
        await sendBestEffortPdf(row.tenant_id, row.recipient_phones, local.dateStr, summary);
      }

      await query(`UPDATE whatsapp_report_schedules SET last_sent_on = $2 WHERE id = $1`, [row.id, local.dateStr]);
      dispatched.push(row.tenant_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[whatsapp-engine:report-dispatch] Dispatch failed for tenant ${row.tenant_id}`, message);
      failed.push({ tenantId: row.tenant_id, error: message });
      // One tenant's failure must not abort the batch — continue to the next.
    }
  }

  console.log(`[whatsapp-engine:report-dispatch] Done — dispatched ${dispatched.length}, skipped ${skipped.length}, failed ${failed.length}`);
  return { dispatched, skipped, failed };
}

// ─── On-demand "Send Test Now" ─────────────────────────────────────────────────

export interface DispatchNowResult {
  results: Array<{ phone: string; status: 'SENT' | 'FAILED'; error?: string }>;
}

/**
 * Sends the tenant's configured report immediately, using its saved
 * recipients/sections — bypassing both the time-window match AND the
 * once-per-day `last_sent_on` guard that `runScheduledReportDispatch()`
 * enforces for the real cron path. Deliberately does NOT touch
 * `last_sent_on`: this is a manual verification send, not a scheduled one,
 * and must not interfere with (or count as) the day's real automated
 * dispatch. Confirmed real need — a tenant configuring/re-configuring a
 * schedule while testing has no way to see it actually work without
 * waiting for a real cron tick, which the once-per-day guard then blocks
 * for the rest of that calendar day.
 */
export async function dispatchReportNow(tenantId: string): Promise<DispatchNowResult> {
  const scheduleResult = await query<{
    recipient_phones: string[];
    included_sections: string[];
    timezone: string;
    currency: string;
  }>(
    `SELECT wrs.recipient_phones, wrs.included_sections, wrs.timezone, t.currency
     FROM whatsapp_report_schedules wrs
     JOIN tenants t ON t.id = wrs.tenant_id
     WHERE wrs.tenant_id = $1`,
    [tenantId],
  );
  const row = scheduleResult.rows[0];
  if (!row) {
    throw new Error('No schedule configured yet — save one first.');
  }
  if (!row.recipient_phones || row.recipient_phones.length === 0) {
    throw new Error('No recipient phone numbers configured.');
  }

  const local = tenantLocalNow(row.timezone);
  const window = localDayWindowUtc(row.timezone, local.dateStr);
  const summary = await computeTodaySummary(tenantId, window);
  const message = formatScheduledReportMessage(summary, row.included_sections, row.currency, local.dateStr);

  const state = await waitForSessionReady(tenantId, 25_000);
  const results: DispatchNowResult['results'] = [];

  if (!state || state.status !== 'READY') {
    const reason = state?.status === 'AUTHENTICATING'
      ? 'WhatsApp session requires re-authentication — visit the WhatsApp page to reconnect'
      : 'WhatsApp session is not connected';
    for (const phone of row.recipient_phones) {
      await logDispatch(tenantId, phone, 'FAILED', reason);
      results.push({ phone, status: 'FAILED', error: reason });
    }
    return { results };
  }

  for (const phone of row.recipient_phones) {
    try {
      await sendMessageFrom(tenantId, phone, message);
      await logDispatch(tenantId, phone, 'SENT', null);
      results.push({ phone, status: 'SENT' });
    } catch (sendErr) {
      const errMessage = sendErr instanceof Error ? sendErr.message : String(sendErr);
      await logDispatch(tenantId, phone, 'FAILED', errMessage);
      results.push({ phone, status: 'FAILED', error: errMessage });
    }
  }
  await sendBestEffortPdf(tenantId, row.recipient_phones, local.dateStr, summary);

  return { results };
}
