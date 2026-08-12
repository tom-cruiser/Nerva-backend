// services/whatsapp-engine/src/lib/report-service.ts
import { sendMessageFrom } from './whatsapp-client';
import { createPOSReportPDF } from './pdf-generator';
import { formatReportMessage } from './report-formatter';
import fs from 'fs/promises';
import path from 'path';

export interface POSReportData {
  tenantId: string;
  date: string;
  period: 'daily' | 'weekly' | 'monthly';
  summary: {
    totalSales: number;
    totalOrders: number;
    averageOrderValue: number;
    topSellingProducts: Array<{
      name: string;
      quantity: number;
      revenue: number;
    }>;
    revenueByCategory: Array<{
      category: string;
      revenue: number;
    }>;
    paymentMethods: Array<{
      method: string;
      amount: number;
      count: number;
    }>;
    hourlySales: Array<{
      hour: string;
      orders: number;
      revenue: number;
    }>;
  };
  recipients: string[];
  options?: {
    sendPDF?: boolean;
    sendMessage?: boolean;
    pdfOptions?: {
      includeCharts?: boolean;
      includeBreakdown?: boolean;
    };
  };
}

export interface ReportSendResult {
  success: boolean;
  messageResults: Array<{
    recipient: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }>;
  pdfGenerated?: {
    path: string;
    size: number;
  };
  errors: string[];
}

/**
 * Send POS report to recipients
 */
export async function sendPOSReport(data: POSReportData): Promise<ReportSendResult> {
  const { tenantId, date, period, summary, recipients, options = {} } = data;
  const { sendPDF = true, sendMessage = true, pdfOptions = {} } = options;
  
  const results: ReportSendResult = {
    success: true,
    messageResults: [],
    errors: []
  };

  console.log(`[report-service] Generating ${period} report for ${tenantId} on ${date}`);

  try {
    // 1. Generate PDF if requested
    let pdfPath: string | undefined;
    if (sendPDF) {
      try {
        const pdfResult = await generatePDFReport(tenantId, date, period, summary, pdfOptions);
        pdfPath = pdfResult.path;
        results.pdfGenerated = {
          path: pdfPath,
          size: pdfResult.size
        };
        console.log(`[report-service] PDF generated: ${pdfPath}`);
      } catch (pdfError) {
        console.error('[report-service] PDF generation failed:', pdfError);
        results.errors.push(`PDF generation failed: ${pdfError instanceof Error ? pdfError.message : 'Unknown error'}`);
        // Continue with message send even if PDF fails
      }
    }

    // 2. Format the report message
    const formattedMessage = formatReportMessage(period, date, summary);

    // 3. Send messages to all recipients
    if (sendMessage) {
      for (const recipient of recipients) {
        try {
          let messageToSend = formattedMessage;
          
          // If PDF is available, add a note about it
          if (pdfPath) {
            messageToSend += `\n\n📄 A detailed PDF report has been attached.`;
          }

          // Send the message
          const result = await sendMessageFrom(tenantId, recipient, messageToSend);
          
          results.messageResults.push({
            recipient,
            success: true,
            messageId: result?.id?._serialized || result?.id
          });

          console.log(`[report-service] Report sent to ${recipient}`);

          // If PDF is available, you could also send it as a media file
          // Note: whatsapp-web.js supports sending media files
          if (pdfPath) {
            try {
              // Send PDF as attachment
              await sendPDFAttachment(tenantId, recipient, pdfPath);
            } catch (attachError) {
              console.error(`[report-service] Failed to send PDF attachment to ${recipient}:`, attachError);
              // Don't fail the whole process if attachment fails
            }
          }

        } catch (sendError) {
          console.error(`[report-service] Failed to send to ${recipient}:`, sendError);
          results.messageResults.push({
            recipient,
            success: false,
            error: sendError instanceof Error ? sendError.message : 'Unknown error'
          });
          results.errors.push(`Failed to send to ${recipient}: ${sendError instanceof Error ? sendError.message : 'Unknown error'}`);
        }
      }
    }

    // 4. Clean up PDF file (optional - or keep for archiving)
    if (pdfPath) {
      // Set a timeout to delete the file after 24 hours
      setTimeout(() => {
        fs.unlink(pdfPath).catch(err => {
          console.error('[report-service] Failed to cleanup PDF:', err);
        });
      }, 24 * 60 * 60 * 1000);
    }

    results.success = results.errors.length === 0;

    return results;

  } catch (error) {
    console.error('[report-service] Report generation failed:', error);
    results.success = false;
    results.errors.push(`Report generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return results;
  }
}

/**
 * Generate PDF report
 */
async function generatePDFReport(
  tenantId: string,
  date: string,
  period: string,
  summary: POSReportData['summary'],
  _options: { includeCharts?: boolean; includeBreakdown?: boolean }
): Promise<{ path: string; size: number }> {
  const pdfDir = path.join(process.cwd(), 'reports');
  await fs.mkdir(pdfDir, { recursive: true });

  const pdfPath = path.join(pdfDir, `report_${tenantId}_${date}_${period}.pdf`);

  // Generate actual PDF bytes (real application/pdf content, not a text
  // file mislabeled with a .pdf extension).
  const pdfBuffer = await createPOSReportPDF(tenantId, date, period, summary);

  await fs.writeFile(pdfPath, pdfBuffer);
  const stats = await fs.stat(pdfPath);

  return { path: pdfPath, size: stats.size };
}

/**
 * Send PDF as WhatsApp attachment
 */
async function sendPDFAttachment(tenantId: string, recipient: string, pdfPath: string): Promise<void> {
  // Note: whatsapp-web.js supports sending media files
  // This is a placeholder implementation
  const { getSession } = await import('./whatsapp-client');
  
  const state = getSession(tenantId);
  if (!state || state.status !== 'READY') {
    throw new Error('WhatsApp session not ready');
  }

  // Read the PDF file
  const pdfBuffer = await fs.readFile(pdfPath);
  
  // Send as media
  const media = new (await import('whatsapp-web.js')).MessageMedia(
    'application/pdf',
    pdfBuffer.toString('base64'),
    `report_${new Date().toISOString().split('T')[0]}.pdf`
  );

  await state.client.sendMessage(recipient, media);
}