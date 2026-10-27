import { createHash } from 'node:crypto';
import { shillingsToCents, type Adapted } from './mpesa.js';

// KCB Buni IPN, the envelope the legacy system already receives from KCB in production:
//   { header: { messageID, originatorConversationID, ... },
//     requestPayload: { primaryData: { businessKey }, additionalData: { notificationData: {
//       businessKey ("<paybill>#<account>"), debitMSISDN, transactionAmt (string, shillings), transactionID, currency,
//       firstName, middleName, lastName, narration ... } } } }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const text = (v: unknown): string | undefined => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() || undefined : undefined);

export function kcbNotificationData(body: unknown): Obj | null {
  return obj(obj(obj(obj(body)?.requestPayload)?.additionalData)?.notificationData);
}
export const isKcbIpnEnvelope = (body: unknown): boolean => kcbNotificationData(body) !== null;

/**
 * KCB and M-Pesa transaction codes share one table, and a payment must never be dropped because a code in one world equals a
 * code in the other. So KCB's codes carry a "KCB" prefix. If the same money were ever reported through both channels, the
 * cost is one extra amount in suspense that a person can see and refund, which is far better than a real payment silently
 * treated as a copy. Codes that would not fit (the engine allows 20 characters, A-Z and 0-9) are shortened by hash.
 */
export function kcbTransCode(id: string): string {
  const clean = id.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length >= 3 && clean.length <= 17 && clean === id.toUpperCase()) return `KCB${clean}`;
  return `KCB${createHash('sha256').update(id).digest('hex').slice(0, 17).toUpperCase()}`;
}

/** What the customer typed is the part after the "#": "8025631#UT-ABCD2345" -> "UT-ABCD2345". */
const accountOf = (businessKey: string | undefined): string | undefined => {
  const after = businessKey?.split('#').pop()?.trim();
  return after || undefined;
};

export function adaptKcbIpn(body: unknown): Adapted {
  const n = kcbNotificationData(body);
  if (!n) return { ok: false, reason: 'Not a KCB notification envelope.' };
  const header = obj(obj(body)?.header) ?? {};
  const currency = (text(n.currency) ?? 'KES').toUpperCase();
  // An amount in another currency must never be booked as shillings. It is kept as received, for a person.
  if (currency !== 'KES') return { ok: false, reason: `The payment is in ${currency}, not KES; it cannot be booked automatically.` };
  const id = text(n.transactionID) ?? (text(header.messageID) ? `msg-${text(header.messageID)}` : undefined);
  if (!id) return { ok: false, reason: 'transactionID and messageID are both missing.' };
  const amountCents = shillingsToCents(n.transactionAmt);
  if (amountCents === null) return { ok: false, reason: `transactionAmt is missing or not a valid amount: ${JSON.stringify(n.transactionAmt) ?? 'undefined'}.` };
  const key = text(n.businessKey) ?? text(obj(obj(obj(body)?.requestPayload)?.primaryData)?.businessKey);
  const payerName = [n.firstName, n.middleName, n.lastName].map(text).filter(Boolean).join(' ') || undefined;
  return { ok: true, notice: { transCode: kcbTransCode(id), amountCents, msisdn: text(n.debitMSISDN), payerName, accountRef: accountOf(key) } };
}

/** A body that is not the envelope (a different Buni product, a flat test payload): look in the places such payloads usually put things. */
export function adaptKcbFlat(body: unknown): Adapted {
  const b = obj(body);
  if (!b) return { ok: false, reason: 'The notice is not an object.' };
  const id = text(b.transactionId) ?? text(b.TransID) ?? text(b.reference) ?? text(b.transactionReference);
  if (!id) return { ok: false, reason: 'No transaction id found (transactionId, TransID, reference or transactionReference).' };
  const raw = b.amount ?? b.TransAmount ?? b.transactionAmount ?? b.Amount;
  const amountCents = shillingsToCents(raw);
  if (amountCents === null) return { ok: false, reason: `The amount is missing or not valid: ${JSON.stringify(raw) ?? 'undefined'}.` };
  return {
    ok: true,
    notice: {
      transCode: kcbTransCode(id), amountCents,
      accountRef: text(b.accountNumber) ?? text(b.BillRefNumber) ?? text(b.paymentReference),
      payerName: text(b.customerName) ?? text(b.payerName) ?? text(b.senderName), msisdn: text(b.MSISDN),
    },
  };
}

export const adaptKcb = (body: unknown): Adapted => (isKcbIpnEnvelope(body) ? adaptKcbIpn(body) : adaptKcbFlat(body));

/** KCB expects its own message ids echoed back, statusCode "0" meaning "received" (not "matched"), and the transaction id. */
export function kcbAck(body: unknown, ok = true): object {
  const n = kcbNotificationData(body) ?? {};
  const h = obj(obj(body)?.header) ?? {};
  return {
    header: {
      messageID: h.messageID ?? null, originatorConversationID: h.originatorConversationID ?? null,
      statusCode: ok ? '0' : '1', statusMessage: ok ? 'Notification received successfully' : 'Temporary failure, please retry',
    },
    responsePayload: { transactionInfo: { transactionID: n.transactionID ?? null } },
  };
}
