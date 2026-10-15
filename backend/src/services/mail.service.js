const nodemailer = require('nodemailer');
const ApiError = require('../utils/ApiError');
const systemConfig = require('./systemConfig.service');

// One place that turns the Settings -> Email configuration into a mail transport, so email
// backups, failure alerts and the test button can never disagree about which server they use.
// The transport is rebuilt whenever the configuration changes (no restart, no stale cache).

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

/** Turns the usual provider failures into something a shop owner can act on. */
function explain(err) {
  const m = String(err.message || err);
  if (/535|Invalid login|Username and Password not accepted|authentication/i.test(m)) return 'The mail server refused the username or password. For Gmail you must use an App Password (not your normal password).';
  if (err.code === 'EDNS' || err.code === 'ENOTFOUND') return 'The mail server name could not be found - check the spelling of the host.';
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || /timeout/i.test(m)) return 'Could not connect to the mail server - check the host and port (587 with "SSL/TLS" off, or 465 with it on), and that this computer can reach the internet.';
  if (/wrong version number|ssl|tls/i.test(m)) return 'A secure-connection mismatch: try port 587 with SSL/TLS off, or port 465 with SSL/TLS on.';
  return m;
}

async function sendTest(to) {
  if (!to) throw new ApiError(400, 'Enter an email address to send the test to.');
  const transport = getTransport();
  try {
    await transport.sendMail({
      from: fromAddress(), to,
      subject: 'Urban Trends POS - test email',
      text: 'If you can read this, outgoing email from your POS works. Backups and alerts will be sent the same way.',
    });
  } catch (err) {
    throw new ApiError(502, explain(err));
  }
}

module.exports = { isConfigured, getTransport, fromAddress, sendTest, explain };
