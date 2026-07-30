import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { getTenantContext } from '@retail/middleware';
import { Errors, sendError } from '@retail/middleware';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ─── TEST ROUTE ──────────────────────────────────────────────────────────────
router.get('/test', (req: Request, res: Response) => {
  console.log('[ledger] ✅ Test endpoint called!');
  res.json({
    status: 'ok',
    message: 'Ledger router is working!',
    timestamp: new Date().toISOString(),
    routes: [
      'GET /test',
      'GET /customers',
      'POST /customers',
      'GET /customers/:customerId',
      'PATCH /customers/:customerId',
      'GET /customers/:customerId/balance',
      'GET /customers/:customerId/transactions',
      'GET /transactions',
      'POST /payments',
      'POST /customers/:customerId/credit',
      'GET /summary',
      'POST /settle',
      'POST /payments/momo',
      'GET /export',
    ]
  });
});

// ─── Schema Definitions ──────────────────────────────────────────────────────

const settleSchema = z.object({
  ledger_id: z.string().uuid(),
  amount: z.number().positive(),
  clientMutationId: z.string().uuid(),
});

const paymentSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.number().positive(),
  method: z.enum(['CASH', 'MOMO', 'BANK_TRANSFER']),
  note: z.string().optional(),
  clientMutationId: z.string().uuid(),
});

const creditSchema = z.object({
  amount: z.number().positive(),
  description: z.string().optional(),
  clientMutationId: z.string().uuid(),
});

const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
  initialBalance: z.number().nonnegative().default(0),
  clientMutationId: z.string().uuid(),
});

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

// ─── Helper Functions ──────────────────────────────────────────────────────

function formatLastActivity(date: Date | string): string {
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const diffMs = now.getTime() - dateObj.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    return dateObj.toLocaleDateString();
  } catch {
    return 'Unknown';
  }
}

function generateCSV(data: Array<Record<string, any>>): string {
  if (data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const rows = data.map(row => 
    headers.map(header => {
      const value = row[header] ?? '';
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    }).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

// ─── GET /api/v1/ledger/customers ──────────────────────────────────────────

router.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();

    try {
      const result = await client.query(
        `SELECT 
           id,
           customer_id,
           customer_name as name,
           customer_phone as phone,
           balance,
           credit_limit,
           total_credit_given,
           total_payments_received,
           last_payment_date,
           last_credit_date,
           updated_at,
           created_at
         FROM customer_ledger
         WHERE tenant_id = $1 AND deleted_at IS NULL
         ORDER BY balance DESC`,
        [orgId],
      );

      const customers = result.rows.map((row: any) => {
        const balance = Number(row.balance || 0);
        return {
          id: row.customer_id || row.id,
          name: row.name || 'Unknown Customer',
          phone: row.phone || 'N/A',
          balance: balance,
          lastActivity: row.updated_at ? formatLastActivity(row.updated_at) : 'Never',
          trend: balance > 0 ? 'up' : balance < 0 ? 'down' : 'flat',
          email: undefined,
          totalPaid: Number(row.total_payments_received || 0),
          totalCredit: Number(row.total_credit_given || 0),
        };
      });

      res.json({ customers });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/ledger/customers ──────────────────────────────────────────

router.post('/customers', async (req: Request, res: Response, next: NextFunction) => {
  console.log('[ledger] POST /customers - Request received');
  console.log('[ledger] Body:', req.body);
  
  try {
    const body = createCustomerSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();

    console.log('[ledger] Creating customer for tenant:', orgId);

    try {
      await client.query('BEGIN');

      const existingCustomer = await client.query(
        `SELECT customer_id, customer_name, customer_phone, balance
         FROM customer_ledger
         WHERE customer_phone = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [body.phone, orgId],
      );

      let customerId: string;
      let isNewCustomer = false;
      let currentBalance = 0;

      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].customer_id;
        currentBalance = Number(existingCustomer.rows[0].balance || 0);
        
        await client.query(
          `UPDATE customer_ledger
           SET customer_name = $1,
               updated_at = NOW(),
               version = version + 1
           WHERE customer_id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
          [body.name, customerId, orgId],
        );
        
        console.log('[ledger] Updated existing customer:', customerId);
        isNewCustomer = false;
      } else {
        isNewCustomer = true;
        customerId = uuidv4();
        const ledgerRecordId = uuidv4();
        
        await client.query(
          `INSERT INTO customer_ledger (
             id, tenant_id, customer_id, customer_name, customer_phone,
             balance, credit_limit, total_credit_given, total_payments_received,
             version, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
          [
            ledgerRecordId,
            orgId,
            customerId,
            body.name,
            body.phone,
            body.initialBalance || 0,
            0,
            body.initialBalance || 0,
            0,
            1
          ],
        );
        
        console.log('[ledger] Created new customer:', customerId);
        currentBalance = body.initialBalance || 0;
      }

      if (!isNewCustomer && body.initialBalance > 0) {
        await client.query(
          `UPDATE customer_ledger
           SET balance = balance + $1,
               total_credit_given = total_credit_given + $1,
               updated_at = NOW(),
               version = version + 1
           WHERE customer_id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
          [body.initialBalance, customerId, orgId],
        );
        currentBalance += body.initialBalance;
      }

      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1, 'customer_ledger', $2, $3, $4, $5::jsonb)`,
        [orgId, customerId, isNewCustomer ? 'CREATE' : 'UPDATE', ctx.workerTag, JSON.stringify({
          name: body.name,
          phone: body.phone,
          initialBalance: body.initialBalance || 0,
          isNewCustomer,
          currentBalance,
        })],
      );

      await client.query('COMMIT');

      console.log('[ledger] Customer created successfully:', customerId);

      res.json({
        id: customerId,
        name: body.name,
        phone: body.phone,
        email: null,
        balance: currentBalance,
        createdAt: new Date().toISOString(),
        isExistingCustomer: !isNewCustomer,
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[ledger] Error creating customer:', err);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/ledger/customers/:customerId ─────────────────────────────

router.get('/customers/:customerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const { customerId } = req.params;
    const client = await getClient();

    try {
      const result = await client.query(
        `SELECT 
           id,
           customer_id,
           customer_name as name,
           customer_phone as phone,
           balance,
           credit_limit,
           total_credit_given,
           total_payments_received,
           last_payment_date,
           last_credit_date,
           updated_at,
           created_at
         FROM customer_ledger
         WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [customerId, ctx.tenantId],
      );

      if (result.rows.length === 0) {
        sendError(res, Errors.notFound('Customer not found'));
        return;
      }

      const row = result.rows[0];
      const balance = Number(row.balance || 0);
      
      res.json({
        id: row.customer_id,
        name: row.name || 'Unknown Customer',
        phone: row.phone || 'N/A',
        email: undefined,
        balance: balance,
        totalPaid: Number(row.total_payments_received || 0),
        totalCredit: Number(row.total_credit_given || 0),
        lastActivity: row.updated_at ? formatLastActivity(row.updated_at) : 'Never',
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/v1/ledger/customers/:customerId ───────────────────────────

router.patch('/customers/:customerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateCustomerSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const { customerId } = req.params;
    const client = await getClient();

    try {
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (body.name) {
        updates.push(`customer_name = $${paramIndex++}`);
        values.push(body.name);
      }
      if (body.phone) {
        updates.push(`customer_phone = $${paramIndex++}`);
        values.push(body.phone);
      }
      updates.push(`updated_at = NOW()`);
      updates.push(`version = version + 1`);

      if (updates.length === 0) {
        sendError(res, Errors.invalidRequest('No fields to update'));
        return;
      }

      values.push(customerId);
      values.push(ctx.tenantId);

      const result = await client.query(
        `UPDATE customer_ledger 
         SET ${updates.join(', ')}
         WHERE customer_id = $${paramIndex} AND tenant_id = $${paramIndex + 1} AND deleted_at IS NULL
         RETURNING customer_id as id, customer_name as name, customer_phone as phone, updated_at`,
        values,
      );

      if (result.rows.length === 0) {
        sendError(res, Errors.notFound('Customer not found'));
        return;
      }

      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1, 'customer_ledger', $2, 'UPDATE', $3, $4::jsonb)`,
        [ctx.tenantId, customerId, ctx.workerTag, JSON.stringify(body)],
      );

      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/ledger/customers/:customerId/balance ────────────────────

router.get('/customers/:customerId/balance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const { customerId } = req.params;
    const client = await getClient();
    try {
      const result = await client.query(
        `SELECT customer_id as id, balance, credit_limit, updated_at
         FROM customer_ledger
         WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [customerId, ctx.tenantId],
      );
      if (result.rows.length === 0) {
        sendError(res, Errors.notFound('Customer not found'));
        return;
      }
      res.json({ 
        customer_id: customerId, 
        balance: Number(result.rows[0].balance),
        credit_limit: Number(result.rows[0].credit_limit),
        updated_at: result.rows[0].updated_at,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/ledger/customers/:customerId/transactions ───────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.get('/customers/:customerId/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const { customerId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const client = await getClient();
    try {
      const ledgerResult = await client.query(
        `SELECT id FROM customer_ledger
         WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [customerId, ctx.tenantId],
      );

      if (ledgerResult.rows.length === 0) {
        sendError(res, Errors.notFound('Customer not found'));
        return;
      }

      const ledgerId = ledgerResult.rows[0].id;

      const result = await client.query(
        `SELECT 
           id,
           amount,
           entry_type as type,
           description,
           created_at as "createdAt"
         FROM ledger_entries
         WHERE customer_ledger_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4`,
        [ledgerId, ctx.tenantId, limit, offset],
      );

      const countResult = await client.query(
        `SELECT COUNT(*) as total
         FROM ledger_entries
         WHERE customer_ledger_id = $1 AND tenant_id = $2`,
        [ledgerId, ctx.tenantId],
      );

      const transactions = result.rows.map((row: any) => ({
        id: row.id,
        amount: Number(row.amount),
        type: row.type === 'PAYMENT' ? 'PAYMENT' : row.type === 'CREDIT' ? 'CREDIT' : row.type,
        description: row.description || '',
        createdAt: row.createdAt?.toISOString(),
      }));

      res.json({
        transactions,
        total: Number(countResult.rows[0]?.total || 0),
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil(Number(countResult.rows[0]?.total || 0) / limit),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/ledger/transactions ──────────────────────────────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const { 
      customerId, 
      limit = 50, 
      offset = 0, 
      fromDate, 
      toDate, 
      type 
    } = req.query;

    const parsedLimit = Math.min(Number(limit) || 50, 100);
    const parsedOffset = Number(offset) || 0;

    const client = await getClient();
    try {
      let query = `
        SELECT 
          le.id,
          le.amount,
          le.entry_type as type,
          le.description as note,
          le.created_at as date,
          cl.customer_id as "customerId",
          cl.customer_name as customer
        FROM ledger_entries le
        JOIN customer_ledger cl ON cl.id = le.customer_ledger_id
        WHERE le.tenant_id = $1 AND cl.deleted_at IS NULL
      `;

      const values: any[] = [ctx.tenantId];
      let paramIndex = 2;

      if (customerId) {
        query += ` AND cl.customer_id = $${paramIndex++}`;
        values.push(customerId);
      }

      if (type) {
        query += ` AND le.entry_type = $${paramIndex++}`;
        values.push(type === 'PAYMENT' ? 'PAYMENT' : type === 'CREDIT' ? 'CREDIT' : type);
      }

      if (fromDate) {
        query += ` AND le.created_at >= $${paramIndex++}`;
        values.push(new Date(fromDate as string));
      }

      if (toDate) {
        query += ` AND le.created_at <= $${paramIndex++}`;
        values.push(new Date(toDate as string));
      }

      const countQuery = query.replace(
        /SELECT[\s\S]*?FROM/,
        'SELECT COUNT(*) as total FROM'
      );
      const countResult = await client.query(countQuery, values.slice(0, paramIndex - 1));

      query += ` ORDER BY le.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      values.push(parsedLimit, parsedOffset);

      const result = await client.query(query, values);

      const transactions = result.rows.map((row: any) => ({
        id: row.id,
        type: row.type === 'PAYMENT' ? 'PAYMENT' : 'CREDIT',
        customer: row.customer || 'Unknown Customer',
        customerId: row.customerId,
        amount: Number(row.amount),
        ref: `TXN-${row.id.slice(0, 8)}`,
        date: row.date ? formatLastActivity(row.date) : 'Unknown',
        balance: 0,
        note: row.note || '',
      }));

      res.json({
        transactions,
        total: Number(countResult.rows[0]?.total || 0),
        page: Math.floor(parsedOffset / parsedLimit) + 1,
        totalPages: Math.ceil(Number(countResult.rows[0]?.total || 0) / parsedLimit),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/ledger/payments ──────────────────────────────────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.post('/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = paymentSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();

    try {
      await client.query('BEGIN');

      const ledgerResult = await client.query(
        `SELECT id, customer_id, balance, total_payments_received
         FROM customer_ledger
         WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [body.customerId, orgId],
      );

      if (ledgerResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Customer not found'));
        return;
      }

      const ledger = ledgerResult.rows[0];
      const currentBalance = Number(ledger.balance || 0);
      
      if (body.amount > currentBalance) {
        await client.query('ROLLBACK');
        sendError(res, Errors.invalidRequest('Payment exceeds outstanding debt'));
        return;
      }

      const txId = uuidv4();
      
      await client.query(
        `INSERT INTO ledger_entries (
           id, tenant_id, customer_ledger_id, entry_type, 
           amount, balance_after, description, worker_tag, created_at
         )
         VALUES ($1, $2, $3, 'PAYMENT', $4, $5, $6, $7, NOW())`,
        [
          txId, 
          orgId, 
          ledger.id, 
          body.amount, 
          currentBalance - body.amount,
          `Payment of ${body.amount} via ${body.method}`,
          ctx.workerTag
        ],
      );

      await client.query(
        `UPDATE customer_ledger 
         SET balance = balance - $1,
             total_payments_received = total_payments_received + $1,
             last_payment_date = NOW(),
             updated_at = NOW(),
             version = version + 1
         WHERE id = $2 AND tenant_id = $3`,
        [body.amount, ledger.id, orgId],
      );

      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1, 'customer_ledger', $2, 'PAYMENT', $3, $4::jsonb)`,
        [orgId, ledger.customer_id, ctx.workerTag, JSON.stringify({ 
          payment_tx: txId, 
          amount: body.amount, 
          method: body.method,
          note: body.note,
          balance_before: currentBalance,
          balance_after: currentBalance - body.amount,
        })],
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        transactionId: txId,
        newBalance: currentBalance - body.amount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/ledger/customers/:customerId/credit ─────────────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.post('/customers/:customerId/credit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = creditSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const { customerId } = req.params;
    const client = await getClient();

    try {
      await client.query('BEGIN');

      let ledgerResult = await client.query(
        `SELECT id, customer_id, balance, total_credit_given
         FROM customer_ledger
         WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [customerId, ctx.tenantId],
      );

      let ledgerId: string;
      let currentBalance = 0;

      if (ledgerResult.rows.length === 0) {
        const newLedgerId = uuidv4();
        await client.query(
          `INSERT INTO customer_ledger (
             id, tenant_id, customer_id, customer_name, customer_phone,
             balance, credit_limit, total_credit_given, total_payments_received,
             version, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
          [newLedgerId, ctx.tenantId, customerId, 'Unknown Customer', null, 0, 0, 0, 0, 1],
        );
        ledgerId = newLedgerId;
        currentBalance = 0;
      } else {
        ledgerId = ledgerResult.rows[0].id;
        currentBalance = Number(ledgerResult.rows[0].balance || 0);
      }

      const txId = uuidv4();
      
      await client.query(
        `INSERT INTO ledger_entries (
           id, tenant_id, customer_ledger_id, entry_type, 
           amount, balance_after, description, worker_tag, created_at
         )
         VALUES ($1, $2, $3, 'CREDIT', $4, $5, $6, $7, NOW())`,
        [
          txId, 
          ctx.tenantId, 
          ledgerId, 
          body.amount, 
          currentBalance + body.amount,
          body.description || 'Credit extension',
          ctx.workerTag
        ],
      );

      await client.query(
        `UPDATE customer_ledger
         SET balance = balance + $1,
             total_credit_given = total_credit_given + $1,
             last_credit_date = NOW(),
             updated_at = NOW(),
             version = version + 1
         WHERE id = $2 AND tenant_id = $3`,
        [body.amount, ledgerId, ctx.tenantId],
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        transactionId: txId,
        newBalance: currentBalance + body.amount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/ledger/summary ─────────────────────────────────────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();

    try {
      const debtResult = await client.query(
        `SELECT 
           COALESCE(SUM(balance), 0) as total_outstanding,
           COUNT(CASE WHEN balance > 0 THEN 1 END) as active_debtors
         FROM customer_ledger
         WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [orgId],
      );

      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const paymentsResult = await client.query(
        `SELECT 
           COALESCE(SUM(amount), 0) as paid_this_month,
           COUNT(*) as payments_received
         FROM ledger_entries
         WHERE tenant_id = $1 
           AND entry_type = 'PAYMENT'
           AND created_at >= $2`,
        [orgId, monthStart],
      );

      const overdueThreshold = new Date();
      overdueThreshold.setDate(overdueThreshold.getDate() - 30);

      const overdueResult = await client.query(
        `SELECT 
           COALESCE(SUM(balance), 0) as overdue_amount,
           COUNT(*) as overdue_customers
         FROM customer_ledger
         WHERE tenant_id = $1 
           AND balance > 0
           AND deleted_at IS NULL
           AND (last_credit_date IS NULL OR last_credit_date < $2)`,
        [orgId, overdueThreshold],
      );

      const totalOutstanding = Number(debtResult.rows[0]?.total_outstanding || 0);
      const activeDebtors = Number(debtResult.rows[0]?.active_debtors || 0);

      res.json({
        totalOutstanding,
        activeDebtors,
        paidThisMonth: Number(paymentsResult.rows[0]?.paid_this_month || 0),
        paymentsReceived: Number(paymentsResult.rows[0]?.payments_received || 0),
        overdue: Number(overdueResult.rows[0]?.overdue_amount || 0),
        overdueCustomers: Number(overdueResult.rows[0]?.overdue_customers || 0),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/ledger/settle ─────────────────────────────────────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.post('/settle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = settleSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      const ledgerQ = await client.query(
        `SELECT id, customer_id, balance 
         FROM customer_ledger 
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [body.ledger_id, orgId],
      );
      if (ledgerQ.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Customer ledger not found'));
        return;
      }

      const ledger = ledgerQ.rows[0];
      const currentBalance = Number(ledger.balance || 0);
      
      if (body.amount > currentBalance) {
        await client.query('ROLLBACK');
        sendError(res, Errors.invalidRequest('Payment exceeds outstanding debt'));
        return;
      }

      // Fetch historical credits to allocate against (FIFO)
      const credits = await client.query(
        `SELECT id, amount, created_at
         FROM ledger_entries
         WHERE customer_ledger_id = $1 AND tenant_id = $2 AND entry_type = 'CREDIT'
         ORDER BY created_at ASC`,
        [body.ledger_id, orgId],
      );

      let remaining = body.amount;
      const allocations: Array<{ credit_id: string; applied: number }> = [];
      for (const row of credits.rows) {
        if (remaining <= 0) break;
        const creditAmount = Number(row.amount);
        if (creditAmount <= 0) continue;
        const applied = Math.min(creditAmount, remaining);
        allocations.push({ credit_id: row.id, applied });
        remaining -= applied;
      }

      if (remaining > 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.internal('Allocation failed — insufficient credit records'));
        return;
      }

      const txId = uuidv4();
      
      await client.query(
        `INSERT INTO ledger_entries (
           id, tenant_id, customer_ledger_id, entry_type, 
           amount, balance_after, description, worker_tag, created_at
         )
         VALUES ($1, $2, $3, 'PAYMENT', $4, $5, $6, $7, NOW())`,
        [
          txId, 
          orgId, 
          body.ledger_id, 
          body.amount, 
          currentBalance - body.amount,
          `Settlement payment with FIFO allocation`,
          ctx.workerTag
        ],
      );

      await client.query(
        `UPDATE customer_ledger 
         SET balance = balance - $1,
             total_payments_received = total_payments_received + $1,
             last_payment_date = NOW(),
             updated_at = NOW(),
             version = version + 1
         WHERE id = $2 AND tenant_id = $3`,
        [body.amount, body.ledger_id, orgId],
      );

      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1, 'customer_ledger', $2, 'PAYMENT', $3, $4::jsonb)`,
        [orgId, ledger.customer_id, ctx.workerTag, JSON.stringify({ 
          payment_tx: txId, 
          amount: body.amount, 
          allocations,
          balance_before: currentBalance,
          balance_after: currentBalance - body.amount,
        })],
      );

      await client.query('COMMIT');
      res.json({ 
        ledger_id: body.ledger_id, 
        settled: body.amount, 
        payment_tx: txId, 
        allocations,
        new_balance: currentBalance - body.amount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/ledger/payments/momo ─────────────────────────────────────

router.post('/payments/momo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const { transaction_id, amount, phone_number, status } = req.body;

    if (!transaction_id || !amount) {
      sendError(res, Errors.invalidRequest('transaction_id and amount are required'));
      return;
    }

    res.json({
      status: 'RECONCILED',
      transaction_id,
      amount,
      phone_number,
      reconciled_at: new Date().toISOString(),
      message: 'MoMo payment reconciled successfully (stub)',
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/ledger/export ─────────────────────────────────────────────
// ✅ FIXED: Using ledger_entries instead of ledger_transactions

router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const { fromDate, toDate, customerId, format = 'csv' } = req.query;

    const client = await getClient();
    try {
      let query = `
        SELECT 
          le.id as transaction_id,
          le.entry_type as type,
          le.amount,
          le.created_at as date,
          cl.customer_name,
          cl.customer_phone,
          le.description
        FROM ledger_entries le
        JOIN customer_ledger cl ON cl.id = le.customer_ledger_id
        WHERE le.tenant_id = $1 AND cl.deleted_at IS NULL
      `;

      const values: any[] = [ctx.tenantId];
      let paramIndex = 2;

      if (customerId) {
        query += ` AND cl.customer_id = $${paramIndex++}`;
        values.push(customerId);
      }

      if (fromDate) {
        query += ` AND le.created_at >= $${paramIndex++}`;
        values.push(new Date(fromDate as string));
      }

      if (toDate) {
        query += ` AND le.created_at <= $${paramIndex++}`;
        values.push(new Date(toDate as string));
      }

      query += ` ORDER BY le.created_at DESC`;

      const result = await client.query(query, values);

      const rows = result.rows.map((row: any) => ({
        'Transaction ID': row.transaction_id,
        'Type': row.type === 'PAYMENT' ? 'PAYMENT' : 'CREDIT',
        'Amount': Number(row.amount),
        'Date': row.date?.toISOString() || '',
        'Customer': row.customer_name || 'Unknown',
        'Phone': row.customer_phone || 'N/A',
        'Description': row.description || '',
      }));

      if (format === 'csv') {
        const csv = generateCSV(rows);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="ledger_export_${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csv);
      } else {
        res.json({ data: rows, count: rows.length });
      }
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

export { router as ledgerRouter };