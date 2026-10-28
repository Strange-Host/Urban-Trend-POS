// The Zettatel bulk-SMS HTTP API, as the legacy system (and the older live one before it) uses it:
//   POST https://portal.zettatel.com/SMSApi/send   (JSON)
//   { userid, password, senderid, msgType, duplicatecheck: "true", sendMethod: "quick", sms: [{ mobile: ["2547XXXXXXXX"], msg: "..." }] }
//
// Honesty note, carried over: the first system never read the gateway's reply, so a rejected message (bad sender id, no credit) looked the
// same as a delivered one. Success here is therefore conservative: HTTP 2xx AND no explicit failure marker in the body. The raw reply is
// kept on every outbox row, so after the first real sends the true success format can be read off sms_outbox.provider_response and this
// check tightened to match.

export const DEFAULT_SEND_URL = 'https://portal.zettatel.com/SMSApi/send';
const TIMEOUT_MS = 15_000;

export interface SmsCredentials { userId: string; password: string; senderId: string; msgType: 'text' | 'unicode' }
export interface SendResult { ok: boolean; error?: string; response?: string | null }

export function interpretResponse(data: unknown): { ok: boolean; error?: string } {
  let parsed: unknown = data;
  if (typeof data === 'string') { try { parsed = JSON.parse(data); } catch { parsed = null; } }
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    const status = String(p.status ?? p.Status ?? '').toLowerCase();
    if (['error', 'failed', 'fail', 'failure', 'rejected'].includes(status)) return { ok: false, error: String(p.reason ?? p.message ?? p.statusDesc ?? `provider status "${status}"`) };
    const code = Number(p.statusCode ?? p.code);
    if (Number.isFinite(code) && code >= 400) return { ok: false, error: String(p.reason ?? p.message ?? `provider code ${code}`) };
  }
  return { ok: true };
}

/**
 * Sends one message. Never throws on a gateway or network failure: it says what happened and the outbox decides about retrying.
 * On failure only a short description is returned, never the request, which holds the account password.
 */
export async function sendSms(f: typeof fetch, creds: SmsCredentials, to: string, message: string, url: string = DEFAULT_SEND_URL): Promise<SendResult> {
  const body = { userid: creds.userId, password: creds.password, senderid: creds.senderId || '', msgType: creds.msgType || 'unicode', duplicatecheck: 'true', sendMethod: 'quick', sms: [{ mobile: [to], msg: message }] };
  try {
    const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}`, response: text };
    return { ...interpretResponse(text), response: text };
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string }; message?: string };
    // A short reason only. Should the account password ever appear in an error message, it is blanked out.
    const redact = (m: string) => (creds.password ? m.split(creds.password).join('***') : m);
    return { ok: false, error: e.cause?.code || e.code || redact(e.message ?? 'network error'), response: null };
  }
}
