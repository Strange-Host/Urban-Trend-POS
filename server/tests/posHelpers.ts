import { checkout, type CheckoutInput, type SaleView } from '../src/pos/sales.js';
import { openSession, recordCashMovement } from '../src/pos/sessions.js';
import { makeEnv, type Env } from './orderHelpers.js';

export { makeEnv };
export type { Env };
export const pos = (env: Env) => ({ pool: env.db.pool });

/** Opens a till for a cashier, optionally funding the drawer with a float (a top-up approved by two other people). */
export async function till(env: Env, cashier = 'cara', floatCents = 0) {
  const s = await openSession(pos(env), { cashier, openingFloatCents: 0 });
  if (floatCents > 0) await recordCashMovement(pos(env), { sessionId: s.id, kind: 'top_up', amountCents: floatCents, reason: 'Opening float from the safe', requestedBy: 'sam', approvedBy: 'mona', approverRole: 'manager' });
  return s;
}

/** A cash sale of `units` x `unitPrice`, with optional extras. */
export function sell(env: Env, over: Partial<CheckoutInput> & { cashier?: string; units?: number; unitPrice?: number } = {}): Promise<SaleView> {
  const units = over.units ?? 2;
  const unitPrice = over.unitPrice ?? 50_000;
  const items = over.items ?? [{ name: 'Sneakers', sku: 'SN-1', quantity: units, unitPriceCents: unitPrice }];
  const gross = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  const lineDisc = items.reduce((s, i) => s + (i.discountCents ?? 0), 0);
  const total = gross - lineDisc - (over.saleDiscountCents ?? 0);
  return checkout(pos(env), {
    cashier: over.cashier ?? 'cara', cashierRole: over.cashierRole ?? 'cashier', items, saleDiscountCents: over.saleDiscountCents, discountReason: over.discountReason,
    payments: over.payments ?? [{ method: 'cash', amountCents: total }], clientSaleId: over.clientSaleId, approval: over.approval,
  });
}

export const MANAGER = { approver: 'mona', approverRole: 'manager' };
export const ADMIN = { approver: 'ada', approverRole: 'admin' };
