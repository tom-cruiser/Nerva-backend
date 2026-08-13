// services/whatsapp-engine/src/lib/report-formatter.ts
import { POSReportData } from './report-service';

export function formatReportMessage(
  period: string,
  date: string,
  summary: POSReportData['summary']
): string {
  const lines = [
    `📊 *${period.toUpperCase()} REPORT*`,
    `📅 ${formatDate(date)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '📈 *SALES SUMMARY*',
    `💰 Total Sales: *$${formatCurrency(summary.totalSales)}*`,
    `📦 Total Orders: *${summary.totalOrders}*`,
    `📊 Avg Order: *$${formatCurrency(summary.averageOrderValue)}*`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '🏆 *TOP SELLING PRODUCTS*',
  ];

  // Top products
  summary.topSellingProducts.slice(0, 5).forEach((product, i) => {
    lines.push(`${i + 1}. ${product.name}`);
    lines.push(`   📦 ${product.quantity} units | 💰 $${formatCurrency(product.revenue)}`);
  });

  if (summary.topSellingProducts.length > 5) {
    lines.push(`   ... and ${summary.topSellingProducts.length - 5} more`);
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📂 *REVENUE BY CATEGORY*');

  // Categories
  summary.revenueByCategory.forEach(category => {
    const percentage = summary.totalSales > 0 ? (category.revenue / summary.totalSales) * 100 : 0;
    const bar = '█'.repeat(Math.round(percentage / 5));
    lines.push(`${category.category}: $${formatCurrency(category.revenue)} (${percentage.toFixed(1)}%)`);
    lines.push(`  ${bar}${'░'.repeat(20 - bar.length)}`);
  });

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('💳 *PAYMENT METHODS*');

  // Payment methods
  summary.paymentMethods.forEach(method => {
    const percentage = summary.totalSales > 0 ? (method.amount / summary.totalSales) * 100 : 0;
    lines.push(`${method.method}: $${formatCurrency(method.amount)} (${method.count} transactions, ${percentage.toFixed(1)}%)`);
  });

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('🕐 *HOURLY BREAKDOWN*');

  // Hourly sales (show peak hours)
  const topHours = summary.hourlySales
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3);

  topHours.forEach(hour => {
    lines.push(`${hour.hour}: ${hour.orders} orders | $${formatCurrency(hour.revenue)}`);
  });

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📱 *Sent from Nerva POS*');
  lines.push(`🕐 ${new Date().toLocaleString()}`);

  return lines.join('\n');
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