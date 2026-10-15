const axios = require('axios');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { encrypt, decrypt } = require('../utils/crypto');
const { logStaffAction } = require('../utils/auditLog');

// Server-level settings that used to be editable ONLY in backend/.env - the public web
// address, outgoing email, allowed website origins, KCB's connection details. They live in
// the settings table now and are edited under Settings (admin only), so nobody has to open a
// file on the server or restart anything. An existing .env value still works as the fallback,
// so installs that already have these in .env keep working untouched; a value saved in
// Settings wins over .env.
//
// The email password is the only secret here: it is stored ENCRYPTED, never returned by any
// endpoint (the UI only learns whether one is set), and written only via save().

const KEYS = [
  'public_base_url', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_from',
  'allowed_origins', 'kcb_api_base_url_sandbox', 'kcb_api_base_url_production', 'kcb_token_path',
];
const SECRET_KEY = 'smtp_pass_enc';
// Keys the generic PUT /api/settings must not write: they have their own validated path above.
const MANAGED_KEYS = new Set([...KEYS, SECRET_KEY, 'module_hr_enabled', 'module_control_enabled']);

function raw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== '' ? row.value : null;
}

const firstSet = (...values) => values.find((v) => v !== null && v !== undefined && String(v).trim() !== '');

// ---------------------------------------------------------------- effective values

function publicBaseUrl() {
  const v = firstSet(raw('public_base_url'), process.env.APP_BASE_URL);
  return v ? String(v).trim().replace(/\/+$/, '') : null;
}

function allowedOrigins() {
  return firstSet(raw('allowed_origins'), process.env.CORS_ORIGIN) || '';
}

function smtp() {
  const stored = raw('smtp_host');
  const useDb = Boolean(stored);
  const host = firstSet(stored, process.env.SMTP_HOST);
  const secureRaw = raw('smtp_secure');
  const encPass = raw(SECRET_KEY);
  return {
    host: host || null,
    port: Number(firstSet(raw('smtp_port'), process.env.SMTP_PORT)) || 587,
    secure: secureRaw !== null ? secureRaw === '1' : process.env.SMTP_SECURE === 'true',
    user: firstSet(raw('smtp_user'), process.env.SMTP_USER) || null,
    pass: encPass ? decrypt(encPass) : (process.env.SMTP_PASS || null),
    from: firstSet(raw('smtp_from'), process.env.SMTP_FROM, raw('smtp_user'), process.env.SMTP_USER) || 'urban-trends-pos@localhost',
    source: useDb ? 'settings' : (host ? 'environment' : null),
  };
}

function kcb() {
  return {
    sandbox: firstSet(raw('kcb_api_base_url_sandbox'), process.env.KCB_API_BASE_URL_SANDBOX) || 'https://uat.buni.kcbgroup.com',
    production: firstSet(raw('kcb_api_base_url_production'), process.env.KCB_API_BASE_URL_PRODUCTION) || 'https://api.buni.kcbgroup.com',
    tokenPath: firstSet(raw('kcb_token_path'), process.env.KCB_TOKEN_PATH) || '/token',
  };
}

// ---------------------------------------------------------------- validation

function normalizeUrl(value, label, { requireHttps = false, requireScheme = false } = {}) {
  const text = String(value).trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (requireScheme && !hasScheme) throw new ApiError(400, `${label} must start with https:// (or http://).`);
  let url;
  try { url = new URL(hasScheme ? text : `https://${text}`); } catch { throw new ApiError(400, `${label} is not a valid web address.`); }
  if (!hasScheme && !/\./.test(url.hostname) && url.hostname !== 'localhost') throw new ApiError(400, `${label} is not a valid web address.`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError(400, `${label} must start with https:// (or http://).`);
  if (requireHttps && url.protocol !== 'https:') throw new ApiError(400, `${label} must start with https:// - Safaricom and KCB only call secure addresses.`);
  if (url.username || url.password) throw new ApiError(400, `${label} must not contain a username or password.`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '') + (url.search ? '' : '');
}

function validate(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (!KEYS.includes(key)) continue;
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (text === '') { out[key] = ''; continue; }
    switch (key) {
      case 'public_base_url': {
        const url = normalizeUrl(text, 'The public web address');
        if (/mpesa|safaricom/i.test(url)) throw new ApiError(400, 'The public web address must not contain the words "mpesa" or "safaricom" - Safaricom rejects such addresses. Use a neutral domain or tunnel address.');
        out[key] = url;
        break;
      }
      case 'allowed_origins': {
        const origins = text.split(/[,\s]+/).filter(Boolean).map((o) => {
          const u = normalizeUrl(o, `"${o}"`, { requireScheme: true });
          return new URL(u).origin;
        });
        out[key] = [...new Set(origins)].join(',');
        break;
      }
      case 'kcb_api_base_url_sandbox':
      case 'kcb_api_base_url_production':
        out[key] = normalizeUrl(text, 'The KCB address', { requireHttps: true });
        break;
      case 'kcb_token_path':
        if (!text.startsWith('/')) throw new ApiError(400, 'The KCB token path must start with a "/" (for example /token).');
        out[key] = text;
        break;
      case 'smtp_host':
        if (/\s|:\/\//.test(text)) throw new ApiError(400, 'The mail server must be a host name like smtp.gmail.com (no spaces, no https://).');
        out[key] = text;
        break;
      case 'smtp_port': {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ApiError(400, 'The mail server port must be a number between 1 and 65535 (usually 587 or 465).');
        out[key] = String(n);
        break;
      }
      case 'smtp_secure':
        out[key] = ['1', 'true', 'yes'].includes(text.toLowerCase()) ? '1' : '0';
        break;
      case 'smtp_from':
        if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(text) && !/^.+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(text)) {
          throw new ApiError(400, 'The "from" address must look like shop@example.com (or Shop Name <shop@example.com>).');
        }
        out[key] = text;
        break;
      default:
        out[key] = text;
    }
  }
  return out;
}

// ---------------------------------------------------------------- read / write

/** What the Settings screen shows. Never includes the email password. */
function describe() {
  const s = smtp();
  const stored = Object.fromEntries(KEYS.map((k) => [k, raw(k) || '']));
  return {
    values: stored,
    effective: {
      public_base_url: publicBaseUrl() || '',
      smtp_host: s.host || '', smtp_port: s.port, smtp_secure: s.secure, smtp_user: s.user || '', smtp_from: s.from,
      allowed_origins: allowedOrigins(),
      kcb: kcb(),
    },
    smtp_password_set: Boolean(raw(SECRET_KEY) || process.env.SMTP_PASS),
    smtp_source: s.source,
    // Settings still satisfied by backend/.env only - harmless, shown so nothing is a mystery.
    from_environment: KEYS.filter((k) => !raw(k) && ({
      public_base_url: process.env.APP_BASE_URL, allowed_origins: process.env.CORS_ORIGIN, smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT, smtp_secure: process.env.SMTP_SECURE, smtp_user: process.env.SMTP_USER, smtp_from: process.env.SMTP_FROM,
      kcb_api_base_url_sandbox: process.env.KCB_API_BASE_URL_SANDBOX, kcb_api_base_url_production: process.env.KCB_API_BASE_URL_PRODUCTION, kcb_token_path: process.env.KCB_TOKEN_PATH,
    })[k]),
  };
}

/**
 * values: any of KEYS (an empty string clears it, falling back to .env / the default).
 * smtp_password: write-only; '' / undefined leaves the saved one alone.
 * clear_smtp_password: true removes it.
 */
function save({ values = {}, smtpPassword, clearSmtpPassword, userId }) {
  const clean = validate(values);
  const before = describe().values;

  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
  `);
  db.transaction(() => {
    for (const [k, v] of Object.entries(clean)) upsert.run(k, v, userId || null);
    if (clearSmtpPassword) db.prepare('DELETE FROM settings WHERE key = ?').run(SECRET_KEY);
    else if (smtpPassword) upsert.run(SECRET_KEY, encrypt(String(smtpPassword)), userId || null);
  })();

  // Audit WHAT changed, never the password itself.
  logStaffAction({
    staffId: userId, action: 'update', entityType: 'system_settings', entityId: userId || 1,
    before, after: { ...describe().values, ...(smtpPassword ? { smtp_password: 'changed' } : {}), ...(clearSmtpPassword ? { smtp_password: 'removed' } : {}) },
  });
  return describe();
}

// ---------------------------------------------------------------- checks

/**
 * Asks THIS server to open the saved (or given) public address. It proves the name resolves
 * and leads to a POS - it can NOT prove the outside world can reach it (a router can allow
 * you in but not strangers, or the reverse), which the message says.
 */
async function checkPublicUrl(candidate) {
  const url = candidate ? normalizeUrl(candidate, 'The public web address') : publicBaseUrl();
  if (!url) throw new ApiError(400, 'Enter your public web address first.');
  try {
    const res = await axios.get(`${url}/api/health`, { timeout: 8000, maxRedirects: 2, validateStatus: () => true });
    const looksLikePos = res.status === 200 && res.data && res.data.status === 'ok';
    if (looksLikePos) {
      return { reachable: true, looks_like_pos: true, http_status: res.status, message: `Reached your POS at ${url}. This server can open that address. (To be sure Safaricom/KCB can too, also try it from a phone on mobile data.)` };
    }
    return { reachable: true, looks_like_pos: false, http_status: res.status, message: `${url} answered (HTTP ${res.status}) but not like this POS. Check it points at the backend (port 4000), e.g. ${url}/api/health should show {"status":"ok"}.` };
  } catch (err) {
    const why = err.code === 'ENOTFOUND' ? 'that name does not exist (check the spelling, or that the tunnel is still running)'
      : err.code === 'ECONNREFUSED' ? 'nothing is listening there'
      : err.code === 'ECONNABORTED' ? 'it took too long to answer'
      : /certificate|SSL|TLS/i.test(err.message) ? 'its security certificate is not valid'
      : err.message;
    return { reachable: false, looks_like_pos: false, http_status: null, message: `Could not open ${url}: ${why}.` };
  }
}

module.exports = {
  KEYS, MANAGED_KEYS, SECRET_KEY,
  publicBaseUrl, allowedOrigins, smtp, kcb,
  describe, save, validate, checkPublicUrl,
};
