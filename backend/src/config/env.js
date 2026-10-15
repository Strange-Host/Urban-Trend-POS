// Loads backend/.env and makes sure the app can start WITHOUT anyone having to
// create or edit it. Required once, at the very top of app.js and config/db.js
// (whichever loads first does the work; Node caches the module so it runs once).
//
// What it does, in order:
//   1. Loads backend/.env — found relative to THIS file, not the current
//      directory, so it works the same under pm2, systemd, an IDE, or `npm start`
//      from any folder.
//   2. Any secret that is missing, empty, or still the placeholder from
//      .env.example is generated (cryptographically random) and written back to
//      backend/.env — created if it doesn't exist, edited in place if it does,
//      leaving every other line and comment alone. A secret that already has a
//      real value is NEVER touched.
//   3. Pins DATABASE_PATH to backend/data/ unless you set one, so the database,
//      backups and logs live in the same place no matter where the server was
//      started from.
//
// Every install therefore gets its own unique secrets — nothing secret ships in
// the project — and a second start finds the file and changes nothing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');

const PLACEHOLDERS = new Set([
  'change_this_to_a_long_random_string',
  'change_this_to_a_different_long_random_string',
]);

// Secrets the app needs and can safely invent for itself.
const AUTO_SECRETS = ['JWT_SECRET', 'ENCRYPTION_KEY', 'PAYMENT_WEBHOOK_SECRET', 'LEAD_INTAKE_SECRET'];

const NEW_FILE_HEADER = [
  '# Created automatically the first time the server started.',
  '# Nothing in this file needs editing for the app to run.',
  '#',
  '# KEEP IT PRIVATE, and back it up together with the data/ folder:',
  '# ENCRYPTION_KEY is what unlocks the SMS and payment-gateway credentials saved',
  '# in the database. If it is lost, those must be entered again in Settings.',
  '#',
  '# Optional settings (CORS_ORIGIN, SMTP_*, BACKUP_EMAIL_TO, ...) are listed in',
  '# .env.example — add any of them to this file only if you need them.',
  '',
];

function isMissing(value) {
  if (value === undefined || value === null) return true;
  const v = String(value).trim();
  return v === '' || PLACEHOLDERS.has(v);
}

function newSecret() {
  return crypto.randomBytes(48).toString('base64url'); // 64 URL-safe characters
}

// Writes `updates` ({ KEY: value }) into the env file: replaces an existing
// KEY=... line in place, appends otherwise, creates the file if needed.
// Atomic (temp file + rename), owner-only permissions.
function persist(envPath, updates) {
  let content = '';
  let existed = true;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existed = false;
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (!existed) content = NEW_FILE_HEADER.join(eol) + eol;
  else if (content.length > 0 && !content.endsWith('\n')) content += eol;

  for (const [key, value] of Object.entries(updates)) {
    const line = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${key}[ \\t]*=.*$`, 'm');
    content = line.test(content)
      ? content.replace(line, (_m, prefix) => `${prefix}${key}=${value}`)
      : `${content}${key}=${value}${eol}`;
  }

  const tmp = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, envPath);
}

function resolveDatabasePath(env) {
  const configured = env.DATABASE_PATH && env.DATABASE_PATH.trim();
  if (!configured) return path.join(BACKEND_DIR, 'data', 'urban_trends.db');
  return path.isAbsolute(configured) ? configured : path.resolve(BACKEND_DIR, configured);
}

/**
 * Exported (rather than run inline) so it can be tested against a temp folder.
 * Returns { generated: [keys], created: boolean }.
 */
function bootstrapEnv({ envPath = path.join(BACKEND_DIR, '.env'), env = process.env, log = console } = {}) {
  const existed = fs.existsSync(envPath);
  if (existed) {
    // dotenv never overrides a variable already set in the real environment,
    // so a value supplied by pm2/systemd/Docker always wins over the file.
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined) env[k] = v;
    }
  }

  env.DATABASE_PATH = resolveDatabasePath(env);

  const missing = AUTO_SECRETS.filter((key) => isMissing(env[key]));
  if (missing.length === 0) return { generated: [], created: false };

  const updates = Object.fromEntries(missing.map((key) => [key, newSecret()]));
  try {
    persist(envPath, updates);
  } catch (err) {
    // Refusing to start is right here: running with secrets that are not saved
    // would silently invalidate every login on each restart and, worse, make
    // credentials encrypted under a one-time key unrecoverable.
    log.error(
      `\nCould not save the generated secrets to ${envPath}: ${err.message}\n` +
      'Make that folder writable, or set JWT_SECRET and ENCRYPTION_KEY yourself in the environment.\n',
    );
    process.exit(1);
  }
  Object.assign(env, updates);

  log.log(`First run: ${existed ? 'filled in the missing secrets in' : 'created'} ${path.relative(process.cwd(), envPath) || envPath} — nothing else to configure.`);

  // A fresh ENCRYPTION_KEY next to an existing database means anything encrypted
  // under an earlier key (SMS / gateway credentials) can no longer be read.
  if (missing.includes('ENCRYPTION_KEY') && fs.existsSync(env.DATABASE_PATH)) {
    log.warn('A new encryption key was created but a database already exists: any SMS or payment-gateway credentials saved earlier cannot be read and must be re-entered in Settings.');
  }

  return { generated: missing, created: !existed };
}

if (process.env.NODE_ENV !== 'test') {
  bootstrapEnv();
} else if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = resolveDatabasePath(process.env);
}

module.exports = { bootstrapEnv, isMissing, resolveDatabasePath, AUTO_SECRETS, BACKEND_DIR };
