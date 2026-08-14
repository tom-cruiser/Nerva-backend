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

// ─── Automated (cron) dispatch message ───────────────────────────────────────

/**
 * Data the scheduled-report cron computes for "today" — a small purpose-
 * built subset, not the full manual-report `POSReportData['summary']` shape
 * (see report-dispatch.ts's computeTodaySummary()).
 */
export interface ScheduledReportSummary {
  totalSales: number;
  totalOrders: number;
  paymentMethods: Array<{ method: string; amount: number; count: number }>;
  topProduct: { name: string; quantity: number; revenue: number } | null;
  lowStockCount: number;
  netProfit: number | null;
  cashierPerformance: Array<{ fullName: string; salesCount: number; revenue: number }>;
}

export type ReportSection = 'sales_summary' | 'cashier_breakdown' | 'low_stock_warnings' | 'profit_metrics';

/**
 * Builds the automated cron dispatch's WhatsApp text — deliberately NOT
 * `formatReportMessage()` above, which unconditionally walks
 * topSellingProducts/revenueByCategory/paymentMethods/hourlySales with no
 * undefined-guards and has no concept of toggleable sections. This mirrors
 * whatsapp-report.md §3.4's literal 4-item format (Total Sales & Gross
 * Revenue, Cash vs MoMo split, Top-Selling Product of the Day, Low-Stock
 * Alerts Count) plus the schedule's own Cashier Breakdown / Profit Metrics
 * toggles, and uses the tenant's real currency instead of a hardcoded `$`.
 */
export function formatScheduledReportMessage(
  summary: ScheduledReportSummary,
  includedSections: string[],
  currency: string,
  dateStr: string,
): string {
  const has = (s: ReportSection) => includedSections.includes(s);
  const money = (n: number) => `${formatCurrency(n)} ${currency}`;
  const lines = [
    `📊 *DAILY REPORT* — ${formatDate(dateStr)}`,
  ];

  if (has('sales_summary')) {
    lines.push(
      '',
      '💰 *SALES SUMMARY*',
      `• Total Sales: *${money(summary.totalSales)}*`,
      `• Total Orders: *${summary.totalOrders}*`,
    );
    if (summary.paymentMethods.length > 0) {
      lines.push('• Payment Methods:');
      summary.paymentMethods.forEach((m) => {
        lines.push(`   - ${m.method}: ${money(m.amount)} (${m.count})`);
      });
    }
    lines.push(
      summary.topProduct
        ? `🏆 Top Product: *${summary.topProduct.name}* (${summary.topProduct.quantity} sold, ${money(summary.topProduct.revenue)})`
        : '🏆 Top Product: no sales yet today',
    );
  }

  if (has('cashier_breakdown')) {
    lines.push('', '👤 *CASHIER BREAKDOWN*');
    if (summary.cashierPerformance.length === 0) {
      lines.push('• No sales recorded yet today');
    } else {
      summary.cashierPerformance.forEach((c) => {
        lines.push(`• ${c.fullName}: ${c.salesCount} sales, ${money(c.revenue)}`);
      });
    }
  }

  if (has('low_stock_warnings')) {
    lines.push(
      '',
      '⚠️ *LOW-STOCK ALERTS*',
      summary.lowStockCount > 0
        ? `• *${summary.lowStockCount}* product(s) at or below reorder level`
        : '• All products are above their reorder level',
    );
  }

  if (has('profit_metrics')) {
    lines.push(
      '',
      '📈 *PROFIT METRICS*',
      summary.netProfit === null
        ? '• Net Profit unavailable — set a cost price on all sold products to see this'
        : `• Net Profit: *${money(summary.netProfit)}*`,
    );
  }

  lines.push('', '📱 _Sent automatically by Nerva POS_');
  return lines.join('\n');
}