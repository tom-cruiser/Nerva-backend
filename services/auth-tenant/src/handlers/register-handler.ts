import { Request, Response, NextFunction } from 'express';
import { Errors } from '@retail/middleware';
import {
  ensureTenant,
  provisionUser,
  findAuthUserIdByEmail,
} from '../lib/user-provisioning';

/**
 * POST /api/v1/auth/register
 *
 * Bootstraps a new workspace: creates the tenant and provisions the OWNER as a
 * Supabase auth user with the correct app_metadata (tenant_id / role), mirrored
 * into the application `users` table. After this, the owner signs in through
 * Supabase directly (the frontend calls signInWithPassword) — no tokens are
 * minted here.
 *
 * Idempotency for the create is provided by X-Client-Mutation-Id at the edge;
 * this handler additionally rejects an email that already has an account so a
 * register never silently moves an existing user to a new tenant.
 */
interface RegisterBody {
  owner_email?:        string;
  password?:           string;
  owner_phone_number?: string;
  organization_name?:  string;
  currency?:           string;
  client_created_at?:  string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Slugify an org name and add a short entropy suffix to keep slugs unique. */
function toSlug(name: string, entropy: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40) || 'workspace';
  return `${base}-${entropy.slice(0, 8)}`;
}

export async function registerHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as RegisterBody;

    const email = body.owner_email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return next(Errors.invalidRequest('A valid owner_email is required'));
    }
    if (!body.password || body.password.length < 8) {
      return next(Errors.invalidRequest('password must be at least 8 characters'));
    }
    if (!body.organization_name || body.organization_name.trim().length < 2) {
      return next(Errors.invalidRequest('organization_name is required'));
    }
    const currency = (body.currency ?? 'XAF').trim().toUpperCase();
    if (currency.length !== 3) {
      return next(Errors.invalidRequest('currency must be a 3-letter ISO-4217 code'));
    }

    // Reject duplicates up front so we never adopt/move an existing user.
    const existing = await findAuthUserIdByEmail(email);
    if (existing) {
      return next(Errors.conflict('An account already exists for that email'));
    }

    const orgName = body.organization_name.trim();
    // Use the client-supplied mutation id (or timestamp) as slug entropy.
    const entropy =
      (req.headers['x-client-mutation-id'] as string | undefined)?.replace(/-/gu, '') ??
      Date.now().toString(36);

    // Self-serve signups land PENDING_APPROVAL, not ACTIVE — a superadmin
    // must approve the workspace (POST /api/v1/superadmin/tenants/:id/approve)
    // before it can be used. See packages/db/src/migrations/
    // 014_tenant_pending_approval.sql and tenant-context.ts's status gate.
    const tenantId = await ensureTenant({
      name:     orgName,
      slug:     toSlug(orgName, entropy),
      currency,
      initialStatus: 'PENDING_APPROVAL',
    });

    const owner = await provisionUser({
      email,
      password: body.password,
      tenantId,
      role:     'OWNER',
    });

    res.status(201).json({
      organization_id:   tenantId,
      organization_name: orgName,
      billing_tier:      'starter',
      currency,
      status:            'PENDING_APPROVAL',
      owner: {
        id:        owner.userId,
        tenantId:  owner.tenantId,
        email:     owner.email,
        role:      owner.role,
        workerTag: owner.workerTag,
        permissions: [],
      },
    });
  } catch (err) {
    return next(err);
  }
}
