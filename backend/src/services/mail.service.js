const nodemailer = require('nodemailer');
const ApiError = require('../utils/ApiError');
const systemConfig = require('./systemConfig.service');

// One place that turns the Settings -> Email configuration into outgoing mail, so email backups,
// failure alerts and the test button can never disagree about how they send.
//
// Mail leaves over SMTP (Gmail, Outlook, Brevo, ...). Note that some hosts block outbound SMTP:
// Railway's Free, Trial and Hobby plans do. The SMTP transport is rebuilt whenever its
// configuration changes (no restart, no stale cache).

let cached = null;
let cachedKey = null;

function isConfigured() {
  return Boolean(systemConfig.smtp().host);
}

function getTransport() {
  const c = systemConfig.smtp();
  if (!c.host) throw new ApiError(400, 'Outgoing email is not set up yet - fill in Settings > Email (outgoing mail).');
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (cached && cachedKey === key) return cached;
  cached = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,   // secure = true for port 465, false for 587/STARTTLS
    auth: c.user ? { user: c.user, pass: c.pass || '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  cachedKey = key;
  return cached;
}

function fromAddress() {
  return systemConfig.smtp().from;
}

/** Turns the usual SMTP failures into something a shop owner can act on. */
function explain(err) {
  const m = String(err.message || err);
  if (/535|Invalid login|Username and Password not accepted|authentication/i.test(m)) return 'The mail server refused the username or password. For Gmail you must use an App Password (not your normal password).';
  if (err.code === 'EDNS' || err.code === 'ENOTFOUND') return 'The mail server name could not be found - check the spelling of the host.';
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || /timeout/i.test(m)) return 'Could not connect to the mail server - check the host and port (587 with "SSL/TLS" off, or 465 with it on). If this POS is hosted on Railway\'s Free, Trial or Hobby plan, outgoing SMTP is blocked there and email cannot be sent from it.';
  if (/wrong version number|ssl|tls/i.test(m)) return 'A secure-connection mismatch: try port 587 with SSL/TLS off, or port 465 with SSL/TLS on.';
  return m;
}

/**
 * Sends one email over SMTP.
 * { to: 'a@x.com, b@y.com' | ['a@x.com'], subject, text, attachments?: [{ filename, path | content }] }
 * Throws an ApiError with advice a shop owner can act on.
 */
async function sendMail({ to, subject, text, attachments }) {
  const transport = getTransport();
  try {
    return await transport.sendMail({
      from: fromAddress(), to: Array.isArray(to) ? to.join(', ') : to, subject, text,
      attachments: (attachments || []).map((a) => (a.content !== undefined ? { filename: a.filename, content: a.content } : { filename: a.filename, path: a.path })),
    });
  } catch (err) {
    throw new ApiError(502, explain(err));
  }
}

async function sendTest(to) {
  if (!to) throw new ApiError(400, 'Enter an email address to send the test to.');
  if (!isConfigured()) throw new ApiError(400, 'Outgoing email is not set up yet - fill in Settings > Email (outgoing mail).');
  await sendMail({
    to,
    subject: 'Urban Trends POS - test email',
    text: 'If you can read this, outgoing email from your POS works. Backups and alerts will be sent the same way.',
  });
}

module.exports = { isConfigured, getTransport, fromAddress, sendMail, sendTest, explain };
