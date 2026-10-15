const crypto = require('crypto');

// Encrypts connected-store credentials (Shopify/WooCommerce secrets) before
// they hit SQLite, so a leaked `data/urban_trends.db` file (or a backup of
// it) doesn't hand over every connected store's live API credentials in
// the clear. AES-256-GCM: authenticated, so a tampered ciphertext fails to
// decrypt rather than silently returning garbage.
const ALGORITHM = 'aes-256-gcm';
const ENC_PREFIX = 'enc:v1:';
// Not a secret — just domain separation so this key can't be reused to
// decrypt something derived from the same passphrase elsewhere.
const KEY_DERIVATION_SALT = 'urban-trends-pos-income-sources';

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Add a long random string to backend/.env — ' +
      'it\'s required to encrypt/decrypt connected-store (Shopify/WooCommerce) credentials.'
    );
  }
  // Derived via scrypt so ENCRYPTION_KEY can be any passphrase (same as
  // JWT_SECRET) rather than requiring a pre-formatted 32-byte hex value.
  cachedKey = crypto.scryptSync(secret, KEY_DERIVATION_SALT, 32);
  return cachedKey;
}

/** Encrypts a plaintext string for storage. Null/undefined/'' pass through unchanged. */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(12); // 96-bit IV, the GCM-recommended size
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a value stored by encrypt(). Values that don't carry the enc:v1:
 * prefix are treated as legacy plaintext (saved before this was added) and
 * returned as-is — so upgrading doesn't break existing connections. They
 * get encrypted automatically the next time that income source is saved.
 */
function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!value.startsWith(ENC_PREFIX)) return value;

  const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
