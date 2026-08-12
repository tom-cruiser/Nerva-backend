// services/whatsapp-engine/src/lib/pdf-generator.ts
// You can use libraries like pdf-lib, puppeteer, or pdfkit

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { POSReportData } from './report-service';

export async function createPOSReportPDF(
  tenantId: string,
  date: string,
  period: string,
  summary: POSReportData['summary']
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 800]);
  const { height } = page.getSize();
  
  // Embed fonts
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  
  let y = height - 50;

  // Helper to draw text
  const drawText = (text: string, fontSize: number = 12, isBold: boolean = false, indent: number = 50) => {
    const f = isBold ? fontBold : font;
    page.drawText(text, {
      x: indent,
      y: y,
      size: fontSize,
      font: f,
      color: rgb(0, 0, 0),
    });
    y -= fontSize + 10;
  };

  // Header
  drawText(`📊 ${period.toUpperCase()} REPORT`, 20, true);
  drawText(`Tenant: ${tenantId}`, 12);
  drawText(`Date: ${formatDate(date)}`, 12);
  y -= 10;

  // Summary
  drawText('━━━━━━━━━━━━━━━━━━━━', 12);
  drawText('📈 SALES SUMMARY', 14, true);
  y -= 5;
  drawText(`Total Sales: $${formatCurrency(summary.totalSales)}`, 12);
  drawText(`Total Orders: ${summary.totalOrders}`, 12);
  drawText(`Average Order Value: $${formatCurrency(summary.averageOrderValue)}`, 12);
  y -= 10;

  // Top Products
  drawText('━━━━━━━━━━━━━━━━━━━━', 12);
  drawText('🏆 TOP SELLING PRODUCTS', 14, true);
  y -= 5;
  summary.topSellingProducts.slice(0, 10).forEach((product, i) => {
    drawText(`${i + 1}. ${product.name}`, 12);
    drawText(`   Quantity: ${product.quantity} | Revenue: $${formatCurrency(product.revenue)}`, 10);
    y -= 5;
  });
  y -= 10;

  // Categories
  drawText('━━━━━━━━━━━━━━━━━━━━', 12);
  drawText('📂 REVENUE BY CATEGORY', 14, true);
  y -= 5;
  summary.revenueByCategory.forEach(category => {
    const percentage = (category.revenue / summary.totalSales) * 100;
    drawText(`${category.category}: $${formatCurrency(category.revenue)} (${percentage.toFixed(1)}%)`, 12);
  });
  y -= 10;

  // Payment Methods
  drawText('━━━━━━━━━━━━━━━━━━━━', 12);
  drawText('💳 PAYMENT METHODS', 14, true);
  y -= 5;
  summary.paymentMethods.forEach(method => {
    const percentage = (method.amount / summary.totalSales) * 100;
    drawText(`${method.method}: $${formatCurrency(method.amount)} (${percentage.toFixed(1)}%)`, 12);
  });

  // Footer
  y = 50;
  drawText(`Generated at: ${new Date().toLocaleString()}`, 10);
  drawText('📱 Powered by Nerva POS', 10);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

function formatDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatCurrency(amount: number): string {
  return amount.toFixed(2);
}