// services/whatsapp-engine/src/routes/report-routes.ts
import { Router } from 'express';
import { sendPOSReport, POSReportData } from '../lib/report-service';
import { getTenantContext, Errors, ApiError, requireFeatureFlag } from '@retail/middleware';

const reportRouter = Router();

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

export { reportRouter };