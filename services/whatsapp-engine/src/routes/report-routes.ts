// services/whatsapp-engine/src/routes/report-routes.ts
import { Router } from 'express';
import { query } from '@retail/db';
import { sendPOSReport, POSReportData } from '../lib/report-service';
import { createPOSReportPDF } from '../lib/pdf-generator';
import { dispatchReportNow } from '../jobs/report-dispatch';
import { getTenantContext, Errors, ApiError, requireFeatureFlag, requirePermission } from '@retail/middleware';

const reportRouter = Router();

// Sections a schedule can toggle on/off in the automated dispatch message
// (whatsapp-report.md's "Included Metrics Checklist").
const VALID_SECTIONS = ['sales_summary', 'cashier_breakdown', 'low_stock_warnings', 'profit_metrics'] as const;
const VALID_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;

interface ScheduleRow {
  enabled:           boolean;
  frequency:         string;
  delivery_time:     string; // Postgres TIME comes back as 'HH:MM:SS'
  timezone:          string;
  day_of_week:       number | null;
  day_of_month:      number | null;
  recipient_phones:  string[];
  included_sections: string[];
  updated_at:        string;
}

function toScheduleResponse(row: ScheduleRow | undefined) {
  if (!row) {
    return {
      enabled: false,
      frequency: 'DAILY',
      deliveryTime: '20:00',
      timezone: 'UTC',
      dayOfWeek: null,
      dayOfMonth: null,
      recipientPhones: [],
      includedSections: ['sales_summary'],
      updatedAt: null,
    };
  }
  return {
    enabled: row.enabled,
    frequency: row.frequency,
    deliveryTime: row.delivery_time.slice(0, 5),
    timezone: row.timezone,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    recipientPhones: row.recipient_phones,
    includedSections: row.included_sections,
    updatedAt: row.updated_at,
  };
}

// Automated WhatsApp reporting is a paid-tier feature (see packages/db's
// 008_subscriptions_and_features.sql `whatsapp_reporting` flag, seeded for
// business/business_premium plans in 013_seed_whatsapp_reporting_flag.sql).
// Gate the two mutating "send it" endpoints; leave the read-only template
// list ungated since it's static metadata, not an actual send.
const requireWhatsappReporting = requireFeatureFlag('whatsapp_reporting');

// POST /send-report - Send POS report
reportRouter.post('/send-report', requireWhatsappReporting, async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required'));
  }

  const { 
    date, 
    period = 'daily',
    summary, 
    recipients,
    options = {}
  } = req.body;

  if (!date) {
    return next(Errors.invalidRequest('date is required'));
  }

  if (!summary) {
    return next(Errors.invalidRequest('summary data is required'));
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return next(Errors.invalidRequest('recipients must be a non-empty array'));
  }

  try {
    console.log(`[reports] Sending ${period} report for ${ctx.tenantId}`);

    const reportData: POSReportData = {
      tenantId: ctx.tenantId,
      date,
      period,
      summary,
      recipients,
      options
    };

    const result = await sendPOSReport(reportData);

    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[reports] Report send error:', err);
    next(new ApiError(err.message || 'Failed to send report', 'REPORT_FAILED', 500));
  }
});

// POST /schedule-report - Schedule recurring reports
reportRouter.post('/schedule-report', requireWhatsappReporting, async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch (ctxErr) {
    return next(Errors.unauthorized('Authentication required'));
  }

  const { 
    schedule, // 'daily' | 'weekly' | 'monthly'
    time, // '09:00' or '18:00'
    recipients,
    options = {}
  } = req.body;

  if (!schedule || !['daily', 'weekly', 'monthly'].includes(schedule)) {
    return next(Errors.invalidRequest('schedule must be daily, weekly, or monthly'));
  }

  if (!time) {
    return next(Errors.invalidRequest('time is required (format: HH:MM)'));
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return next(Errors.invalidRequest('recipients must be a non-empty array'));
  }

  try {
    // Here you would save the schedule to a database
    // For now, we'll just acknowledge it
    console.log(`[reports] Scheduled ${schedule} report for ${ctx.tenantId} at ${time}`);

    res.json({
      success: true,
      message: `Report scheduled for ${schedule} at ${time}`,
      schedule: {
        tenantId: ctx.tenantId,
        schedule,
        time,
        recipients,
        options
      },
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[reports] Schedule error:', err);
    next(new ApiError(err.message || 'Failed to schedule report', 'SCHEDULE_FAILED', 500));
  }
});

// GET /report-templates - Get report templates
reportRouter.get('/report-templates', async (_req, res) => {
  // Return available report templates
  res.json({
    templates: [
      {
        id: 'daily-sales',
        name: 'Daily Sales Report',
        description: 'Daily sales summary with top products and revenue breakdown',
        fields: ['totalSales', 'totalOrders', 'topProducts', 'revenueByCategory']
      },
      {
        id: 'weekly-sales',
        name: 'Weekly Sales Report',
        description: 'Weekly sales summary with trends and comparisons',
        fields: ['totalSales', 'totalOrders', 'weeklyTrend', 'topProducts']
      },
      {
        id: 'payment-methods',
        name: 'Payment Methods Report',
        description: 'Breakdown of payment methods used',
        fields: ['paymentMethods', 'amounts', 'counts']
      }
    ]
  });
});

// GET /schedule - Get the tenant's automated WhatsApp report schedule
// (whatsapp-report.md §2). Ungated by the feature flag so the settings UI
// can render "here's your config" / "here's the default" either way — only
// actually turning it on (POST below) requires the paid feature.
reportRouter.get('/schedule', requirePermission('whatsapp:send'), async (_req, res, next) => {
  try {
    const ctx = getTenantContext(res);
    const result = await query<ScheduleRow>(
      `SELECT enabled, frequency, delivery_time::text, timezone, day_of_week, day_of_month,
              recipient_phones, included_sections, updated_at
       FROM whatsapp_report_schedules WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    res.json(toScheduleResponse(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /schedule - Create or update the tenant's automated WhatsApp report
// schedule. Actually persists (unlike the legacy /schedule-report stub
// above, which only ever logged and echoed a fake success).
reportRouter.post('/schedule', requireWhatsappReporting, requirePermission('whatsapp:send'), async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch {
    return next(Errors.unauthorized('Authentication required'));
  }

  const {
    enabled,
    frequency,
    deliveryTime,
    timezone,
    dayOfWeek,
    dayOfMonth,
    recipientPhones,
    includedSections,
  } = req.body ?? {};

  if (typeof enabled !== 'boolean') {
    return next(Errors.invalidRequest('enabled must be a boolean'));
  }
  if (!VALID_FREQUENCIES.includes(frequency)) {
    return next(Errors.invalidRequest(`frequency must be one of ${VALID_FREQUENCIES.join(', ')}`));
  }
  if (typeof deliveryTime !== 'string' || !TIME_RE.test(deliveryTime)) {
    return next(Errors.invalidRequest('deliveryTime must be in HH:MM format (24-hour)'));
  }
  if (typeof timezone !== 'string' || timezone.trim().length === 0) {
    return next(Errors.invalidRequest('timezone is required'));
  }
  if (frequency === 'WEEKLY' && !(Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6)) {
    return next(Errors.invalidRequest('dayOfWeek (0=Sunday..6=Saturday) is required when frequency is WEEKLY'));
  }
  if (frequency === 'MONTHLY' && !(Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31)) {
    return next(Errors.invalidRequest('dayOfMonth (1-31) is required when frequency is MONTHLY'));
  }
  if (!Array.isArray(recipientPhones) || recipientPhones.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
    return next(Errors.invalidRequest('recipientPhones must be an array of non-empty phone strings'));
  }
  if (enabled && recipientPhones.length === 0) {
    return next(Errors.invalidRequest('At least one recipient phone is required to enable automated reports'));
  }
  const sections = Array.isArray(includedSections) ? includedSections : [];
  if (sections.some((s) => !VALID_SECTIONS.includes(s))) {
    return next(Errors.invalidRequest(`includedSections may only contain: ${VALID_SECTIONS.join(', ')}`));
  }

  try {
    const result = await query<ScheduleRow>(
      `INSERT INTO whatsapp_report_schedules
         (tenant_id, enabled, frequency, delivery_time, timezone, day_of_week, day_of_month,
          recipient_phones, included_sections, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency,
         delivery_time = EXCLUDED.delivery_time, timezone = EXCLUDED.timezone,
         day_of_week = EXCLUDED.day_of_week, day_of_month = EXCLUDED.day_of_month,
         recipient_phones = EXCLUDED.recipient_phones, included_sections = EXCLUDED.included_sections,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING enabled, frequency, delivery_time::text, timezone, day_of_week, day_of_month,
                 recipient_phones, included_sections, updated_at`,
      [
        ctx.tenantId, enabled, frequency, deliveryTime, timezone.trim(),
        frequency === 'WEEKLY' ? dayOfWeek : null,
        frequency === 'MONTHLY' ? dayOfMonth : null,
        JSON.stringify(recipientPhones.map((p: string) => p.trim())),
        JSON.stringify(sections.length > 0 ? sections : ['sales_summary']),
        ctx.userId,
      ],
    );
    res.json(toScheduleResponse(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /schedule/logs - Recent automated-dispatch history for the tenant's
// schedule. Without this, the Scheduled Messages UI has no way to show
// whether the cron actually ran/sent anything — a shop owner had no signal
// beyond asking someone to check the backend logs directly.
reportRouter.get('/schedule/logs', requirePermission('whatsapp:send'), async (_req, res, next) => {
  try {
    const ctx = getTenantContext(res);
    const result = await query<{
      recipient_phone: string;
      status: 'SENT' | 'FAILED';
      sent_at: string;
      error_details: string | null;
    }>(
      `SELECT recipient_phone, status, sent_at, error_details
       FROM whatsapp_report_logs WHERE tenant_id = $1
       ORDER BY sent_at DESC LIMIT 20`,
      [ctx.tenantId],
    );
    res.json({
      logs: result.rows.map((r) => ({
        recipientPhone: r.recipient_phone,
        status: r.status,
        sentAt: r.sent_at,
        errorDetails: r.error_details,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /schedule/test-send - Send the configured report immediately.
// Bypasses both the delivery-time match and the once-per-day guard the
// real cron enforces (dispatchReportNow() does NOT touch last_sent_on) —
// confirmed real need: a tenant configuring a schedule had no way to
// verify it actually works without waiting for (and then being blocked by
// the once-per-day guard after) a real cron tick.
reportRouter.post('/schedule/test-send', requireWhatsappReporting, requirePermission('whatsapp:send'), async (_req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch {
    return next(Errors.unauthorized('Authentication required'));
  }
  try {
    const result = await dispatchReportNow(ctx.tenantId);
    res.json(result);
  } catch (err: any) {
    next(new ApiError(err.message || 'Failed to send test report', 'REPORT_FAILED', 500));
  }
});

// POST /pdf - Generate a downloadable PDF for the Admin Reports page's
// "Export PDF" button. Reuses createPOSReportPDF exactly as the manual
// send-report flow does; the caller already has the full `summary` object
// in hand from GET /api/v1/sync/analytics/sales-report, so no new
// aggregation query is needed here. Gated by reports:read (a base Reports
// feature), NOT the whatsapp_reporting flag — this has nothing to do with
// sending WhatsApp messages.
reportRouter.post('/pdf', requirePermission('reports:read'), async (req, res, next) => {
  let ctx;
  try {
    ctx = getTenantContext(res);
  } catch {
    return next(Errors.unauthorized('Authentication required'));
  }

  const { date, period, summary } = req.body ?? {};
  if (typeof date !== 'string' || !date) {
    return next(Errors.invalidRequest('date is required'));
  }
  if (!summary) {
    return next(Errors.invalidRequest('summary is required'));
  }

  try {
    const pdfBuffer = await createPOSReportPDF(ctx.tenantId, date, period ?? 'daily', summary);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_${date}.pdf"`);
    res.status(200).send(pdfBuffer);
  } catch (err: any) {
    console.error('[reports] PDF export error:', err);
    next(new ApiError(err.message || 'Failed to generate PDF', 'REPORT_FAILED', 500));
  }
});

export { reportRouter };