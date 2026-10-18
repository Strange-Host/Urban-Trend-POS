const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const ApiError = require('../utils/ApiError');
const systemConfig = require('./systemConfig.service');

// One place that turns the Settings -> Email configuration into outgoing mail, so email backups,
// failure alerts and the test button can never disagree about how they send.
//
// Two ways out, chosen in Settings -> Email:
//   * smtp   - a classic mail server (Gmail, Outlook...). Needs outbound SMTP ports, which some
//              hosts block (Railway Free/Trial/Hobby plans do).
//   * resend - Resend's HTTPS API (port 443). Works on any host. Needs only an API key.
// Callers use sendMail() and never see which one is active. The SMTP transport is rebuilt
// whenever its configuration changes (no restart, no stale cache).

const RESEND_URL = 'https://api.resend.com/emails';
// Resend rejects an email over 40 MB after encoding; keep a safety margin under that.
const RESEND_MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024; // base64 grows data by ~4/3 -> ~37 MB on the wire

let cached = null;
let cachedKey = null;

function provider() {
  return systemConfig.mailProvider();
}

function isConfigured() {
  if (provider() === 'resend') return Boolean(systemConfig.resend().apiKey);
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
  return provider() === 'resend' ? systemConfig.resend().from : systemConfig.smtp().from;
}

/** Turns the usual SMTP failures into something a shop owner can act on. */
function explain(err) {
  const m = String(err.message || err);
  if (/535|Invalid login|Username and Password not accepted|authentication/i.test(m)) return 'The mail server refused the username or password. For Gmail you must use an App Password (not your normal password).';
  if (err.code === 'EDNS' || err.code === 'ENOTFOUND') return 'The mail server name could not be found - check the spelling of the host.';
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || /timeout/i.test(m)) return 'Could not connect to the mail server - check the host and port (587 with "SSL/TLS" off, or 465 with it on). If this POS is hosted on Railway\'s Free, Trial or Hobby plan, outgoing SMTP is blocked there: switch the email method to Resend in Settings -> Email.';
  if (/wrong version number|ssl|tls/i.test(m)) return 'A secure-connection mismatch: try port 587 with SSL/TLS off, or port 465 with SSL/TLS on.';
  return m;
}

/** Turns a failed call to the Resend API into something a shop owner can act on. */
function explainResend(err) {
  const status = err.response && err.response.status;
  const body = err.response && err.response.data;
  const apiMessage = body && typeof body === 'object' && body.message ? String(body.message) : '';
  if (status === 401 || (status === 403 && /api key/i.test(apiMessage))) return 'Resend refused the API key. Copy it again from resend.com -> API Keys (it starts with "re_") and save it here.';
  if (status === 403 && /verify a domain|your own email|testing emails/i.test(apiMessage)) {
    return `Resend only lets you send to your own Resend sign-up address until you verify a domain. Either send to that address, or verify a domain at resend.com -> Domains and use an address on it as "Send from". (Resend said: ${apiMessage})`;
  }
  if (status === 403 && /domain/i.test(apiMessage)) return `The "Send from" address is on a domain Resend has not verified. Verify the domain at resend.com -> Domains, or clear the field to use Resend's test address. (Resend said: ${apiMessage})`;
  if (status === 422) return `Resend did not accept the message: ${apiMessage || 'check the "Send from" and recipient addresses.'}`;
  if (status === 429) return 'Resend says too many emails were sent too quickly (the free plan allows 100 per day). Try again later.';
  if (status === 413) return 'The backup file is too large to email through Resend.';
  if (status && apiMessage) return `Resend error (${status}): ${apiMessage}`;
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'Could not look up api.resend.com - the server has no internet access, or DNS is failing.';
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(String(err.message))) return 'Resend took too long to answer. Try again in a moment.';
  return `Could not send through Resend: ${err.message || err}`;
}

function recipientList(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return list.map((e) => String(e).trim()).filter(Boolean);
}

async function sendViaResend({ to, subject, text, attachments }) {
  const { apiKey, from } = systemConfig.resend();
  if (!apiKey) throw new ApiError(400, 'Outgoing email is not set up yet - paste your Resend API key in Settings > Email (outgoing mail).');
  const recipients = recipientList(to);
  if (!recipients.length) throw new ApiError(400, 'There is nobody to send the email to.');
  if (recipients.length > 50) throw new ApiError(400, 'Resend accepts at most 50 recipients per email.');

  const files = [];
  let total = 0;
  for (const a of attachments || []) {
    const content = a.content !== undefined ? Buffer.from(a.content) : fs.readFileSync(a.path);
    total += content.length;
    files.push({ filename: a.filename, content: content.toString('base64') });
  }
  if (total > RESEND_MAX_ATTACHMENT_BYTES) {
    throw new ApiError(413, `The backup is ${(total / 1048576).toFixed(0)} MB, which is too large to email through Resend (limit about ${(RESEND_MAX_ATTACHMENT_BYTES / 1048576).toFixed(0)} MB). Local backups are unaffected.`);
  }

  try {
    const res = await axios.post(RESEND_URL, {
      from, to: recipients, subject, text,
      ...(files.length ? { attachments: files } : {}),
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 45000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    return { id: res.data && res.data.id };
  } catch (err) {
    throw new ApiError(502, explainResend(err));
  }
}

async function sendViaSmtp({ to, subject, text, attachments }) {
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

/**
 * Sends one email by whichever method Settings -> Email selects.
 * { to: 'a@x.com, b@y.com' | ['a@x.com'], subject, text, attachments?: [{ filename, path | content }] }
 * Throws an ApiError with advice a shop owner can act on.
 */
async function sendMail(message) {
  return provider() === 'resend' ? sendViaResend(message) : sendViaSmtp(message);
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

module.exports = { isConfigured, provider, getTransport, fromAddress, sendMail, sendTest, explain, explainResend };
