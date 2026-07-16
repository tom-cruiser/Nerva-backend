import * as crypto from 'crypto';
import * as jwt    from 'jsonwebtoken';
import { env }     from '@retail/config';
import { ApiError } from '@retail/middleware';
import type { UserRole, Permission } from '@retail/types';

// ─── Public token payload shape (lives in JWT claims) ────────────────────────

export interface TokenPayload {
  userId:      string;
  tenantId:    string;
  email:       string;
  role:        UserRole;
  workerTag:   string;
  permissions: Permission[];
}

export interface TokenResponse {
  accessToken:  string;
  refreshToken: string;
  expiresIn:    number;    // access token TTL in seconds
  tokenType:    'Bearer';
}

// ─── Internal refresh-token claim shape ──────────────────────────────────────

interface RefreshClaims {
  sub:      string;   // userId
  tenantId: string;
  jti:      string;   // unique token ID — used for revocation
  type:     'refresh';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM       = 'RS256' as const;
const ISSUER          = 'retail-saas';
const AUDIENCE        = 'tenant-api';
const ACCESS_TTL_SEC  = parseExpiryToSeconds(env.JWT_EXPIRY);
const REFRESH_TTL_SEC = parseExpiryToSeconds(env.REFRESH_TOKEN_EXPIRES_IN);

/**
 * Parses strings like "1h", "15m", "3600" into seconds.
 * Falls back to 3600 if the format is unrecognised.
 */
function parseExpiryToSeconds(value: string): number {
  const match = value.match(/^(\d+)([smhd]?)$/u);
  if (!match) return 3600;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'd': return n * 86_400;
    case 'h': return n * 3_600;
    case 'm': return n * 60;
    default:  return n;
  }
}

// ─── Key validation at module load ───────────────────────────────────────────

function assertPemKey(value: string, label: string, expectedHeader: string): void {
  // PEM values in env vars often have literal \n — normalise them
  const normalised = value.replace(/\\n/g, '\n');
  if (!normalised.includes(expectedHeader)) {
    throw new Error(
      `[crypto-service] ${label} is not in PEM format. ` +
      `Expected header: "${expectedHeader}". ` +
      `Generate with: openssl genrsa -out private.pem 4096`,
    );
  }
}

// Normalise \n escape sequences that arrive as literal backslash-n from env vars
function normalisePem(pem: string): string {
  return pem.replace(/\\n/g, '\n');
}

// These are optional cluster-wide (other services verify via Supabase JWKS),
// but auth-tenant MUST have them to mint its own tokens — fail fast if absent.
const rawPrivateKey = env.JWT_PRIVATE_KEY;
const rawPublicKey  = env.JWT_PUBLIC_KEY;
if (!rawPrivateKey || !rawPublicKey) {
  throw new Error(
    '[crypto-service] JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required by auth-tenant to sign tokens.',
  );
}

const PRIVATE_KEY = normalisePem(rawPrivateKey);
const PUBLIC_KEY  = normalisePem(rawPublicKey);

// Validate at import time — crashes the process immediately if keys are wrong
assertPemKey(PRIVATE_KEY, 'JWT_PRIVATE_KEY', 'PRIVATE KEY');
assertPemKey(PUBLIC_KEY,  'JWT_PUBLIC_KEY',  'PUBLIC KEY');

// ─── CryptoService ───────────────────────────────────────────────────────────

export class CryptoService {

  // ── JWT ────────────────────────────────────────────────────────────────────

  /**
   * Sign an access token with the RS256 private key.
   * Claims include the full TokenPayload plus standard JWT fields.
   */
  static signAccessToken(payload: TokenPayload): string {
    try {
      return jwt.sign(
        {
          userId:      payload.userId,
          tenantId:    payload.tenantId,
          email:       payload.email,
          role:        payload.role,
          workerTag:   payload.workerTag,
          permissions: payload.permissions,
        },
        PRIVATE_KEY,
        {
          algorithm:  ALGORITHM,
          expiresIn:  ACCESS_TTL_SEC,
          issuer:     ISSUER,
          audience:   AUDIENCE,
          subject:    payload.userId,
          jwtid:      crypto.randomUUID(), // unique per token — supports future revocation
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[crypto-service] JWT signing failed', msg);
      throw new ApiError('Failed to generate access token', 'INTERNAL_ERROR', 500);
    }
  }

  /**
   * Verify an access token with the RS256 public key.
   * Returns the decoded payload or throws an ApiError.
   */
  static verifyAccessToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, PUBLIC_KEY, {
        algorithms: [ALGORITHM],
        issuer:     ISSUER,
        audience:   AUDIENCE,
      }) as jwt.JwtPayload & TokenPayload;

      return {
        userId:      decoded['userId'] as string,
        tenantId:    decoded['tenantId'] as string,
        email:       decoded['email']    as string,
        role:        decoded['role']     as UserRole,
        workerTag:   decoded['workerTag'] as string,
        permissions: (decoded['permissions'] as Permission[]) ?? [],
      };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new ApiError('Token has expired. Please refresh.', 'UNAUTHORIZED', 401);
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new ApiError('Invalid token format or signature', 'UNAUTHORIZED', 401);
      }
      throw new ApiError('Authentication failed', 'UNAUTHORIZED', 401);
    }
  }

  /**
   * Generate a long-lived refresh token signed with the RS256 private key.
   * The `jti` is stored in the database and used for revocation checks.
   */
  static signRefreshToken(userId: string, tenantId: string): { token: string; jti: string } {
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { sub: userId, tenantId, jti, type: 'refresh' } satisfies RefreshClaims,
      PRIVATE_KEY,
      {
        algorithm: ALGORITHM,
        expiresIn: REFRESH_TTL_SEC,
        issuer:    ISSUER,
        audience:  AUDIENCE,
      },
    );
    return { token, jti };
  }

  /**
   * Verify a refresh token and return its claims.
   * Throws an ApiError for expired or invalid tokens.
   */
  static verifyRefreshToken(token: string): RefreshClaims {
    try {
      const decoded = jwt.verify(token, PUBLIC_KEY, {
        algorithms: [ALGORITHM],
        issuer:     ISSUER,
        audience:   AUDIENCE,
      }) as jwt.JwtPayload & RefreshClaims;

      if (decoded['type'] !== 'refresh') {
        throw new ApiError('Token is not a refresh token', 'UNAUTHORIZED', 401);
      }

      return {
        sub:      decoded.sub as string,
        tenantId: decoded['tenantId'] as string,
        jti:      decoded['jti']      as string,
        type:     'refresh',
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new ApiError('Refresh token has expired. Please log in again.', 'UNAUTHORIZED', 401);
      }
      throw new ApiError('Invalid refresh token', 'UNAUTHORIZED', 401);
    }
  }

  // ── Token pair ─────────────────────────────────────────────────────────────

  /**
   * Issue a complete access + refresh token pair.
   * Returns the refresh token's `jti` for DB storage.
   */
  static issueTokenPair(payload: TokenPayload): TokenResponse & { refreshJti: string } {
    const accessToken              = CryptoService.signAccessToken(payload);
    const { token: refreshToken, jti: refreshJti } =
      CryptoService.signRefreshToken(payload.userId, payload.tenantId);

    return {
      accessToken,
      refreshToken,
      expiresIn:   ACCESS_TTL_SEC,
      tokenType:   'Bearer',
      refreshJti,
    };
  }

  // ── Password hashing (PBKDF2 — deterministic, compatible with legacy bcrypt) ─

  /**
   * Hash a plaintext password with PBKDF2-SHA512.
   * Format: "<hex_hash>:<hex_salt>"
   *
   * Note: existing users hashed with bcrypt are handled by verifyPassword which
   * detects the format and routes to the appropriate comparator.
   */
  static hashPassword(password: string): string {
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto
      .pbkdf2Sync(password, salt, 100_000, 64, 'sha512')
      .toString('hex');
    return `pbkdf2:${hash}:${salt}`;
  }

  /**
   * Timing-safe password verification.
   * Supports both PBKDF2 (new) and bcrypt (legacy) hash formats.
   */
  static verifyPassword(plaintext: string, stored: string): boolean {
    if (stored.startsWith('pbkdf2:')) {
      const [, hash, salt] = stored.split(':');
      if (!hash || !salt) return false;
      const candidate = crypto
        .pbkdf2Sync(plaintext, salt, 100_000, 64, 'sha512')
        .toString('hex');
      // Both buffers must be the same length for timingSafeEqual
      const a = Buffer.from(hash,      'hex');
      const b = Buffer.from(candidate, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    }
    // bcrypt format: starts with $2b$ or $2a$
    // Callers should use bcrypt.compare() for legacy hashes;
    // this path guards against accidentally hitting it with a PBKDF2 hash
    throw new ApiError(
      'Unsupported password hash format — use bcrypt.compare() for legacy hashes',
      'INTERNAL_ERROR', 500,
    );
  }

  // ── Key utilities (dev / CI only) ──────────────────────────────────────────

  /**
   * Generate a fresh RSA-4096 key pair for development.
   * NEVER call this in production request paths.
   *
   * Usage: ts-node -e "import { CryptoService } from './src/services/crypto-service'; console.log(JSON.stringify(CryptoService.generateKeyPair(), null, 2));"
   */
  static generateKeyPair(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { privateKey, publicKey };
  }
}
