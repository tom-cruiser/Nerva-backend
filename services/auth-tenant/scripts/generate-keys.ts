/**
 * RSA key-pair generator for development / CI setup.
 *
 * Usage:
 *   npx ts-node services/auth-tenant/scripts/generate-keys.ts
 *
 * Output: prints the two env var assignments to stdout so you can copy them
 * directly into your .env file. The private key is printed ONCE — store it safely.
 *
 * NEVER commit the generated keys to version control.
 */
import * as crypto from 'crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Collapse multi-line PEM to single-line env var format (literal \n)
const inline = (pem: string): string => pem.replace(/\n/g, '\\n');

console.log('\n# ── Paste into .env ─────────────────────────────────────────');
console.log(`JWT_PRIVATE_KEY="${inline(privateKey)}"`);
console.log(`JWT_PUBLIC_KEY="${inline(publicKey)}"`);
console.log('# ─────────────────────────────────────────────────────────────\n');
console.log('⚠  Store the private key securely. Never commit it to git.\n');
