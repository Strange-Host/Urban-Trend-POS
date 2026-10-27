import type { PaybillNotice } from '../orders/payments.js';

// Safaricom's C2B notices, turned into what the engine understands. Field names are Daraja's:
//   TransID, TransTime (yyyyMMddHHmmss, East Africa Time), TransAmount, BusinessShortCode, BillRefNumber, MSISDN,
//   FirstName, MiddleName, LastName.

/**
 * Shillings to cents without floating point: "1500.00", "1,500", 1500.5 -> 150000, 150000, 150050.
 * Anything that is not a plain positive decimal with at most two places gives null, never a guess: "1,500.00" read by a bare
 * parseFloat would be 1, and a wrong amount on a payment is worse than a payment a person has to look at.
 */
export function shillingsToCents(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[,\s]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** "20261028143000" is 28 Oct 2026, 14:30:00 in Nairobi. Undefined when it is missing or not a real time. */
export function parseTransTime(v: unknown): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(v ?? ''));
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export type Adapted = { ok: true; notice: PaybillNotice } | { ok: false; reason: string };

const text = (v: unknown): string | undefined => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() || undefined : undefined);

export function adaptMpesaConfirmation(body: unknown): Adapted {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'The notice is not an object.' };
  const b = body as Record<string, unknown>;
  const transCode = text(b.TransID);
  if (!transCode) return { ok: false, reason: 'TransID is missing.' };
  const amountCents = shillingsToCents(b.TransAmount);
  if (amountCents === null) return { ok: false, reason: `TransAmount is missing or not a valid amount: ${JSON.stringify(b.TransAmount) ?? 'undefined'}.` };
  const payerName = [b.FirstName, b.MiddleName, b.LastName].map(text).filter(Boolean).join(' ') || undefined;
  return {
    ok: true,
    notice: { transCode, amountCents, msisdn: text(b.MSISDN), payerName, accountRef: text(b.BillRefNumber), receivedAt: parseTransTime(b.TransTime) },
  };
}

// Safaricom wants the same acknowledgement whatever we did with the money: 0 means "received", not "matched". Anything else
// makes it treat the delivery as failed. We always accept at validation time too, because bouncing a customer's payment at
// the till is worse than recording it for a person to match afterwards.
export const VALIDATION_ACCEPTED = { ResultCode: 0, ResultDesc: 'Accepted' } as const;
export const CONFIRMATION_RECEIVED = { ResultCode: 0, ResultDesc: 'Success' } as const;
export const TEMPORARY_FAILURE = { ResultCode: 1, ResultDesc: 'Temporary failure, please retry' } as const;

// Lipa Na M-Pesa Online (STK push) result: { Body: { stkCallback: { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc,
// CallbackMetadata: { Item: [{ Name, Value }] } } } }. It arrives whether the customer paid, cancelled or let it time out.
// The order reference is NOT in it, so it is recovered from what was stored when the push was sent.
export interface StkResult {
  checkoutRequestId: string; merchantRequestId?: string; resultCode: number; resultDesc?: string; succeeded: boolean;
  amount?: unknown; receipt?: string; phone?: string;
}

export function adaptStkCallback(body: unknown): StkResult | null {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } } | null | undefined)?.Body?.stkCallback;
  if (!cb || typeof cb !== 'object') return null;
  const checkoutRequestId = text(cb.CheckoutRequestID);
  if (!checkoutRequestId || typeof cb.ResultCode !== 'number') return null;
  const items = Array.isArray((cb.CallbackMetadata as { Item?: unknown } | undefined)?.Item) ? ((cb.CallbackMetadata as { Item: Array<{ Name?: string; Value?: unknown }> }).Item) : [];
  const find = (name: string) => items.find((i) => i?.Name === name)?.Value;
  return {
    checkoutRequestId, merchantRequestId: text(cb.MerchantRequestID), resultCode: cb.ResultCode, resultDesc: text(cb.ResultDesc),
    succeeded: cb.ResultCode === 0, amount: find('Amount'), receipt: text(find('MpesaReceiptNumber')), phone: text(find('PhoneNumber')),
  };
}
