const axios = require('axios');

// Zettatel bulk-SMS HTTP API — the contract below is copied from the older
// (live) Urban Trends system's ZettatelSmsProvider, which has been sending
// real messages through it:
//
//   POST https://portal.zettatel.com/SMSApi/send   (JSON)
//   { userid, password, senderid, msgType: "unicode", duplicatecheck: "true",
//     sendMethod: "quick", sms: [ { mobile: ["2547XXXXXXXX"], msg: "..." } ] }
//
// HONESTY NOTE: the older system never parsed Zettatel's reply — it logged
// whatever came back and treated "no exception" as success, so a rejected
// message (bad sender id, no credit) looked identical to a delivered one. The
// success test below is therefore deliberately conservative: HTTP 2xx AND no
// explicit failure marker in the body. The truncated raw reply is stored on
// every outbox row, so after the FIRST real send you can read Zettatel's true
// success/failure format off sms_outbox.provider_response and tighten
// `interpretResponse` to match, exactly like the KCB adapter note.
const SEND_URL = process.env.ZETTATEL_SEND_URL || 'https://portal.zettatel.com/SMSApi/send';
const TIMEOUT_MS = 15_000; // the older system had NO timeout — a slow vendor could hang its threads

function interpretResponse(data) {
  let parsed = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); } catch (_) { parsed = null; }
  }
  if (parsed && typeof parsed === 'object') {
    const status = String(parsed.status ?? parsed.Status ?? '').toLowerCase();
    if (['error', 'failed', 'fail', 'failure', 'rejected'].includes(status)) {
      return { ok: false, error: parsed.reason || parsed.message || parsed.statusDesc || `provider status "${status}"` };
    }
    const code = Number(parsed.statusCode ?? parsed.code);
    if (Number.isFinite(code) && code >= 400) {
      return { ok: false, error: parsed.reason || parsed.message || `provider code ${code}` };
    }
  }
  return { ok: true };
}

/**
 * Sends one SMS. Resolves { ok, error?, response } and NEVER throws on a
 * provider/network failure — the outbox worker decides about retries.
 * `creds` = { userId, password, senderId, msgType }.
 */
async function sendSms({ creds, to, message }) {
  const body = {
    userid: creds.userId,
    password: creds.password,
    senderid: creds.senderId || '',
    msgType: creds.msgType || 'unicode',
    duplicatecheck: 'true',
    sendMethod: 'quick',
    sms: [{ mobile: [to], msg: message }],
  };
  try {
    const res = await axios.post(SEND_URL, body, {
      timeout: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true, // judge the status ourselves so a 4xx body can be recorded
    });
    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const response = String(raw ?? '').slice(0, 500);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}`, response };
    }
    const verdict = interpretResponse(res.data);
    return { ...verdict, response };
  } catch (err) {
    // Deliberately only err.message — axios errors embed the request config,
    // which here would include the account password.
    return { ok: false, error: err.code || err.message || 'network error', response: null };
  }
}

module.exports = { sendSms, interpretResponse, SEND_URL };
