import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';

/** Records a push at the moment it is sent, so its callback can find the order reference again. Used by the STK initiation (a later slice). */
export async function recordStkPushRequest(db: Queryable, input: {
  checkoutRequestId: string; merchantRequestId?: string; accountReference: string; phone?: string; amountCents: number; actor: string;
}): Promise<void> {
  if (!input.checkoutRequestId.trim() || !input.accountReference.trim()) throw new HttpError(422, 'VALIDATION', 'A push needs a CheckoutRequestID and an account reference.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(422, 'VALIDATION', 'A push needs a positive amount.');
  await db.query(
    `INSERT INTO stk_push_requests (checkout_request_id, merchant_request_id, account_reference, phone, amount_cents, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (checkout_request_id) DO NOTHING`,
    [input.checkoutRequestId, input.merchantRequestId ?? null, input.accountReference, input.phone ?? null, input.amountCents, input.actor]);
}
