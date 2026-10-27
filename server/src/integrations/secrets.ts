import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';

// Secrets at rest: AES-256-GCM. The key is derived from SECRETS_KEY (never stored in the database). Each blob is bound to its
// own slot ("provider/name"), so a ciphertext copied into another row, or another provider's row, fails to open instead of
// quietly working. Format: v1.<iv>.<tag>.<ciphertext>, each part base64url.

const deriveKey = (master: string): Buffer => Buffer.from(hkdfSync('sha256', master, 'utpos-secrets-v1', 'aes-256-gcm', 32));

export function encryptSecret(plain: string, masterKey: string, slot: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', deriveKey(masterKey), iv);
  c.setAAD(Buffer.from(slot));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Throws if the blob was tampered with, belongs to another slot, or was made with a different key. */
export function decryptSecret(blob: string, masterKey: string, slot: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format.');
  const d = createDecipheriv('aes-256-gcm', deriveKey(masterKey), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(slot));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

const slotOf = (provider: string, name: string) => `${provider}/${name}`;

export async function putSecret(db: Queryable, masterKey: string | undefined, input: { provider: string; name: string; value: string; actor: string }): Promise<void> {
  if (!masterKey) throw new HttpError(503, 'SECRETS_KEY_MISSING', 'Secrets cannot be stored: SECRETS_KEY is not set on this server.');
  if (!input.value) throw new HttpError(422, 'VALIDATION', 'A secret cannot be empty.');
  await db.query(
    `INSERT INTO integration_secrets (provider, name, ciphertext, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [input.provider, input.name, encryptSecret(input.value, masterKey, slotOf(input.provider, input.name)), input.actor]);
}

/** null when there is no such secret, or no key to open it with. A secret that exists but will not open is an error worth hearing about. */
export async function getSecret(db: Queryable, masterKey: string | undefined, provider: string, name: string): Promise<string | null> {
  if (!masterKey) return null;
  const { rows } = await db.query<{ ciphertext: string }>(`SELECT ciphertext FROM integration_secrets WHERE provider = $1 AND name = $2`, [provider, name]);
  return rows[0] ? decryptSecret(rows[0].ciphertext, masterKey, slotOf(provider, name)) : null;
}

/** Compares two strings without revealing, through timing, how much of the guess was right (or how long the real one is). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
