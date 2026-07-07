/**
 * token-service.ts — thin re-export shim.
 *
 * All cryptographic operations are centralised in CryptoService.
 * This module exists so existing import paths in handlers don't break
 * while the codebase transitions to importing from crypto-service directly.
 */
export { CryptoService } from '../services/crypto-service';
export type { TokenPayload, TokenResponse } from '../services/crypto-service';
