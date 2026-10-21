import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { setDiscountPolicy } from '../src/pos/policy.js';
import { checkout, getSale, refundSale, voidSale } from '../src/pos/sales.js';
import { closeSession, expectedByMethod, openSession } from '../src/pos/sessions.js';
import { ADMIN, MANAGER, makeEnv, pos, sell, till, type Env } from './posHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); await till(env, 'cara', 500_000); }, 60_000);
afterAll(() => env.db.drop());

describe('PHASE 6 DONE WHEN: checkout, void, refund and close-out all post to the ledger', () => {
  it('a day at the till, end to end: the books balance, the count reconciles, integrity is clean', async () => {
    const e = await makeEnv();
    try {
      const s = await till(e, 'dee', 100_000);
      const sale1 = await sell(e, { cashier: 'dee', units: 2, unitPrice: 50_000 });                                    // checkout: 100,000 cash
      const sale2 = await sell(e, { cashier: 'dee', units: 1, unitPrice: 80_000, payments: [{ method: 'mobile_money', amountCents: 80_000, reference: 'QXY1234567' }] });
      const sale3 = await sell(e, { cashier: 'dee', units: 1, unitPrice: 30_000 });                                    // will be voided
      await voidSale(pos(e), { saleId: sale3.id, reason: 'Customer changed their mind', actor: 'dee', ...MANAGER });   // void
      await refundSale(pos(e), { saleId: sale1.id, items: [{ saleItemId: sale1.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'One pair was the wrong size', actor: 'dee', ...MANAGER }); // refund
      // expected: cash = 100,000 float + 100,000 sale - 50,000 refund = 150,000; mobile money 80,000; card 0
      expect(await expectedByMethod(e.db.pool, s.id)).toEqual({ cash: 150_000, card: 0, mobile_money: 80_000 });
      const tillBefore = await accountBalance(e.db.pool, 'TILL');
      const closed = await closeSession(pos(e), { sessionId: s.id, actor: 'dee', counted: { cash: 149_000, card: 0, mobile_money: 80_000 }, varianceReason: 'Gave 1,000 too little change' }); // close-out
      expect(closed.counts.find((c) => c.method === 'cash')).toMatchObject({ expectedCents: 150_000, countedCents: 149_000, varianceCents: -1_000 });
      expect(await accountBalance(e.db.pool, 'TILL')).toBe(tillBefore - 1_000);               // the books now match the count
      expect(await accountBalance(e.db.pool, 'CASH_OVER_SHORT')).toBe(1_000);
      expect(await accountBalance(e.db.pool, 'SALES')).toBe(-(100_000 + 80_000 - 50_000));    // sales net of the refund; the voided sale is gone
      expect((await trialBalance(e.db.pool)).totalCents).toBe(0);
      expect((await runIntegrityChecks(e.db.pool)).violations).toEqual([]);
      void sale2;
    } finally { await e.db.drop(); }
  }, 60_000);
});

describe('checkout', () => {
  it('a till session is required to sell, and a cashier has only one open', async () => {
    await expect(sell(env, { cashier: 'nobody' })).rejects.toMatchObject({ code: 'NO_OPEN_SESSION' });
    await expect(openSession(pos(env), { cashier: 'cara', openingFloatCents: 0 })).rejects.toMatchObject({ code: 'SESSION_ALREADY_OPEN' });
    await expect(openSession(pos(env), { cashier: ' ', openingFloatCents: 0 })).rejects.toMatchObject({ code: 'SESSION_NO_CASHIER' });
    await expect(openSession(pos(env), { cashier: 'x', openingFloatCents: -1 })).rejects.toMatchObject({ code: 'SESSION_BAD_FLOAT' });
  });

  it('posts payments in and gross sales out, and numbers the sale S-YYMM-NNNNNN', async () => {
    const before = await accountBalance(env.db.pool, 'TILL');
    const sale = await sell(env, { units: 3, unitPrice: 40_000 });
    expect(sale).toMatchObject({ status: 'completed', grossCents: 120_000, totalCents: 120_000, lineDiscountCents: 0, saleDiscountCents: 0 });
    expect(sale.saleNo).toMatch(/^S-\d{4}-\d{6}$/);
    expect(await accountBalance(env.db.pool, 'TILL')).toBe(before + 120_000);
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
    const next = await sell(env);
    expect(Number(next.saleNo.slice(-6))).toBe(Number(sale.saleNo.slice(-6)) + 1); // gapless
  });

  it('a split payment posts each method to its own account', async () => {
    const [t, c, m] = await Promise.all(['TILL', 'CARD_CLEARING', 'MOBILE_MONEY_TILL'].map((a) => accountBalance(env.db.pool, a)));
    const sale = await sell(env, { units: 1, unitPrice: 100_000, payments: [{ method: 'cash', amountCents: 20_000 }, { method: 'card', amountCents: 30_000, reference: 'AUTH991' }, { method: 'mobile_money', amountCents: 50_000, reference: 'QXY0000001' }] });
    expect(sale.payments.map((p) => [p.method, p.amountCents])).toEqual([['cash', 20_000], ['card', 30_000], ['mobile_money', 50_000]]);
    expect([await accountBalance(env.db.pool, 'TILL'), await accountBalance(env.db.pool, 'CARD_CLEARING'), await accountBalance(env.db.pool, 'MOBILE_MONEY_TILL')]).toEqual([t! + 20_000, c! + 30_000, m! + 50_000]);
  });

  it('validates the sale and the payments, and leaves nothing behind when refused', async () => {
    const sales = (await env.db.pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n;
    const entries = (await env.db.pool.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n;
    await expect(sell(env, { items: [] })).rejects.toMatchObject({ code: 'SALE_NO_ITEMS' });
    await expect(sell(env, { items: [{ name: 'x', quantity: 0, unitPriceCents: 100 }] })).rejects.toMatchObject({ code: 'SALE_BAD_AMOUNT' });
    await expect(sell(env, { items: [{ name: 'x', quantity: 1, unitPriceCents: 10.5 }] })).rejects.toMatchObject({ code: 'SALE_BAD_AMOUNT' });
    await expect(sell(env, { payments: [{ method: 'cash', amountCents: 1 }] })).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
    await expect(sell(env, { payments: [] })).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    await expect(sell(env, { payments: [{ method: 'cash', amountCents: 50_000 }, { method: 'cash', amountCents: 50_000 }] })).rejects.toMatchObject({ code: 'PAYMENT_DUPLICATE_METHOD' });
    await expect(sell(env, { payments: [{ method: 'card', amountCents: 100_000 }] })).rejects.toMatchObject({ code: 'PAYMENT_REFERENCE_REQUIRED' });
    await expect(sell(env, { payments: [{ method: 'mobile_money', amountCents: 100_000, reference: ' ' }] })).rejects.toMatchObject({ code: 'PAYMENT_REFERENCE_REQUIRED' });
    // @ts-expect-error: not a real method
    await expect(sell(env, { payments: [{ method: 'barter', amountCents: 100_000 }] })).rejects.toMatchObject({ code: 'PAYMENT_BAD_METHOD' });
    await expect(sell(env, { items: [{ name: 'free', quantity: 1, unitPriceCents: 0 }], payments: [{ method: 'cash', amountCents: 1 }] })).rejects.toMatchObject({ code: 'SALE_TOTAL_NOT_POSITIVE' });
    expect((await env.db.pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n).toBe(sales);
    expect((await env.db.pool.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(entries);
  });

  it('THE DATABASE refuses a sale whose payments do not add up, and a sale that is edited or deleted', async () => {
    const sale = await sell(env);
    await expect(env.db.pool.query(`UPDATE sales SET total_cents = 1, gross_cents = 1 WHERE id = $1`, [sale.id])).rejects.toThrow(/never changes/);
    await expect(env.db.pool.query(`DELETE FROM sales WHERE id = $1`, [sale.id])).rejects.toThrow(/cannot be deleted/);
    await expect(env.db.pool.query(`UPDATE sale_items SET quantity = 9`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`UPDATE sale_payments SET amount_cents = 1`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`TRUNCATE sales CASCADE`)).rejects.toThrow(/immutable/);
    const c = await env.db.pool.connect();
    try {
      await c.query('BEGIN');
      const row = await c.query(`SELECT session_id, entry_id FROM sales WHERE id = $1`, [sale.id]);
      await c.query(
        `INSERT INTO sales (sale_no, session_id, cashier, cashier_role, gross_cents, total_cents, entry_id) VALUES ('S-9999-000001', $1, 'x', 'cashier', 1000, 1000, $2)`,
        [row.rows[0].session_id, row.rows[0].entry_id]);
      await c.query(`INSERT INTO sale_payments (sale_id, method, amount_cents) SELECT id, 'cash', 999 FROM sales WHERE sale_no = 'S-9999-000001'`);
      await expect(c.query('COMMIT')).rejects.toThrow(/payments add up/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('is safe to send twice: the same client sale id returns the first sale and posts once', async () => {
    const input = { clientSaleId: 'offline-0001-abcd', units: 1, unitPrice: 25_000 };
    const first = await sell(env, input);
    const second = await sell(env, input);
    expect(first.replayed).toBeUndefined();
    expect(second).toMatchObject({ id: first.id, saleNo: first.saleNo, replayed: true });
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM sales WHERE client_sale_id = 'offline-0001-abcd'`)).rows[0].n).toBe(1);
    await expect(sell(env, { ...input, unitPrice: 26_000 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('five copies of one queued sale arriving at once make exactly one sale', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => sell(env, { clientSaleId: 'burst-sale-0001', units: 1, unitPrice: 12_000 })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});

describe('discounts: caps, reason codes, role limits and manager approval', () => {
  it('a discount can never exceed its line, or add up to the whole sale', async () => {
    await expect(sell(env, { items: [{ name: 'x', quantity: 1, unitPriceCents: 1_000, discountCents: 1_001 }], discountReason: 'loyalty' })).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_LINE' });
    await expect(sell(env, { units: 1, unitPrice: 10_000, saleDiscountCents: 10_000, discountReason: 'loyalty', cashierRole: 'admin' })).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_SALE' });
    await expect(sell(env, { items: [{ name: 'x', quantity: 1, unitPriceCents: 10_000, discountCents: 6_000 }], saleDiscountCents: 4_000, discountReason: 'loyalty', cashierRole: 'admin' })).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_SALE' });
  });

  it('the DATABASE also refuses an over-discounted sale or one with no reason, whatever the code does', async () => {
    const base = await sell(env);
    const ins = (gross: number, line: number, sale: number, total: number, reason: string | null) => env.db.pool.query(
      `INSERT INTO sales (sale_no, session_id, cashier, cashier_role, gross_cents, line_discount_cents, sale_discount_cents, total_cents, discount_reason, entry_id)
       SELECT 'S-9998-000001', session_id, 'x', 'cashier', $1, $2, $3, $4, $5, entry_id FROM sales WHERE id = $6`, [gross, line, sale, total, reason, base.id]);
    await expect(ins(1000, 600, 500, -100, 'loyalty')).rejects.toThrow(/discounts_within_gross|total_cents_check|total_cents/);
    await expect(ins(1000, 0, 100, 900, null)).rejects.toThrow(/discount_needs_reason/);
  });

  it('any discount needs an active reason code', async () => {
    await expect(sell(env, { saleDiscountCents: 1_000 })).rejects.toMatchObject({ code: 'DISCOUNT_REASON_REQUIRED' });
    await expect(sell(env, { saleDiscountCents: 1_000, discountReason: 'because' })).rejects.toMatchObject({ code: 'DISCOUNT_REASON_UNKNOWN' });
    await env.db.pool.query(`UPDATE discount_reasons SET active = false WHERE code = 'promotion'`);
    await expect(sell(env, { saleDiscountCents: 1_000, discountReason: 'promotion' })).rejects.toMatchObject({ code: 'DISCOUNT_REASON_UNKNOWN' });
    await env.db.pool.query(`UPDATE discount_reasons SET active = true WHERE code = 'promotion'`);
    expect((await sell(env, { saleDiscountCents: 1_000, discountReason: 'promotion' })).saleDiscountCents).toBe(1_000);
  });

  it('a cashier can give up to their limit (5%) freely: exactly at the limit is allowed, one cent over is not', async () => {
    const atLimit = await sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 5_000, discountReason: 'loyalty' });
    expect(atLimit.totalCents).toBe(95_000);
    expect((await env.db.pool.query(`SELECT 1 FROM discount_approvals WHERE sale_id = $1`, [atLimit.id])).rowCount).toBe(0);
    await expect(sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 5_001, discountReason: 'loyalty' }))
      .rejects.toMatchObject({ code: 'DISCOUNT_NEEDS_APPROVAL', details: { limitBp: 500, discountBp: 501 } });
  });

  it('line and sale discounts count together toward the limit', async () => {
    await expect(sell(env, { items: [{ name: 'x', quantity: 1, unitPriceCents: 100_000, discountCents: 3_000 }], saleDiscountCents: 3_000, discountReason: 'loyalty' })).rejects.toMatchObject({ code: 'DISCOUNT_NEEDS_APPROVAL' });
  });

  it('above the limit a manager approves it, and the approval is recorded', async () => {
    const sale = await sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 20_000, discountReason: 'price_match', approval: MANAGER });
    expect(sale.totalCents).toBe(80_000);
    const a = (await env.db.pool.query(`SELECT approver, approver_role, discount_bp, reason_code FROM discount_approvals WHERE sale_id = $1`, [sale.id])).rows[0];
    expect(a).toEqual({ approver: 'mona', approver_role: 'manager', discount_bp: 2000, reason_code: 'price_match' });
  });

  it('refuses approval by the cashier themselves, by someone who cannot approve, or beyond the approver\'s own ceiling', async () => {
    const big = { units: 1, unitPrice: 100_000, saleDiscountCents: 20_000, discountReason: 'price_match' };
    await expect(sell(env, { ...big, approval: { approver: 'cara', approverRole: 'manager' } })).rejects.toMatchObject({ code: 'DISCOUNT_SELF_APPROVAL' });
    await expect(sell(env, { ...big, approval: { approver: 'other-cashier', approverRole: 'cashier' } })).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
    await expect(sell(env, { ...big, approval: { approver: 'x', approverRole: 'wizard' } })).rejects.toMatchObject({ code: 'UNKNOWN_ROLE' });
    // a manager can approve up to 50%; 60% needs an admin
    const huge = { units: 1, unitPrice: 100_000, saleDiscountCents: 60_000, discountReason: 'manager_goodwill' };
    await expect(sell(env, { ...huge, approval: MANAGER })).rejects.toMatchObject({ code: 'DISCOUNT_ABOVE_APPROVER_LIMIT', details: { ceilingBp: 5000, discountBp: 6000 } });
    expect((await sell(env, { ...huge, approval: ADMIN })).totalCents).toBe(40_000);
  });

  it('a manager discounting themselves has a higher free limit (20%), and an unknown role is refused', async () => {
    expect((await sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 20_000, discountReason: 'loyalty', cashierRole: 'manager' })).totalCents).toBe(80_000);
    await expect(sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 1_000, discountReason: 'loyalty', cashierRole: 'intern' })).rejects.toMatchObject({ code: 'UNKNOWN_ROLE' });
  });

  it('limits are versioned policy, never edited: a new policy takes effect from its date', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await setDiscountPolicy(env.db.pool, { role: 'cashier', freeLimitBp: 1000, approveCeilingBp: 0, effectiveFrom: future, actor: 'admin' });
    await expect(sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 8_000, discountReason: 'loyalty' })).rejects.toMatchObject({ code: 'DISCOUNT_NEEDS_APPROVAL' }); // not in force yet
    await expect(setDiscountPolicy(env.db.pool, { role: 'cashier', freeLimitBp: 1000, approveCeilingBp: 0, effectiveFrom: future, actor: 'admin' })).rejects.toMatchObject({ code: 'POLICY_EXISTS' });
    await expect(setDiscountPolicy(env.db.pool, { role: 'cashier', freeLimitBp: 900, approveCeilingBp: 0, effectiveFrom: future, actor: 'admin' })).rejects.toMatchObject({ code: 'POLICY_EXISTS' }); // same role and date: never edited
    await expect(setDiscountPolicy(env.db.pool, { role: 'cashier', freeLimitBp: 9000, approveCeilingBp: 100, effectiveFrom: '2031-01-01', actor: 'admin' })).rejects.toMatchObject({ code: 'POLICY_INVALID' }); // an approver's ceiling cannot be below its free limit
    await expect(setDiscountPolicy(env.db.pool, { role: 'cashier', freeLimitBp: 20_000, approveCeilingBp: 0, effectiveFrom: '2030-01-01', actor: 'admin' })).rejects.toMatchObject({ code: 'POLICY_INVALID' });
    await expect(env.db.pool.query(`UPDATE discount_policies SET free_limit_bp = 10000`)).rejects.toThrow(/immutable/);
  });

  it('the discount posts to its own account, so it is visible, and the sale still balances', async () => {
    const before = await accountBalance(env.db.pool, 'SALES_DISCOUNTS');
    await sell(env, { units: 1, unitPrice: 100_000, saleDiscountCents: 4_000, discountReason: 'damaged_item' });
    expect(await accountBalance(env.db.pool, 'SALES_DISCOUNTS')).toBe(before + 4_000);
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
  });
});

describe('voiding a sale', () => {
  it('reverses the ledger entry exactly, needs a manager and a reason, and removes the cash from what is expected', async () => {
    const e = await makeEnv();
    try {
      const s = await till(e, 'vic', 0);
      const sale = await sell(e, { cashier: 'vic', units: 1, unitPrice: 70_000, saleDiscountCents: 3_000, discountReason: 'loyalty' });
      const salesBefore = await accountBalance(e.db.pool, 'SALES');
      const v = await voidSale(pos(e), { saleId: sale.id, reason: 'Wrong item rung up', actor: 'vic', ...MANAGER });
      expect(v).toMatchObject({ status: 'voided' });
      expect(salesBefore).toBe(-70_000);
      for (const a of ['SALES', 'SALES_DISCOUNTS', 'TILL']) expect(await accountBalance(e.db.pool, a)).toBe(0);
      expect((await expectedByMethod(e.db.pool, s.id)).cash).toBe(0);
      await expect(voidSale(pos(e), { saleId: sale.id, reason: 'again', actor: 'vic', ...MANAGER })).rejects.toMatchObject({ code: 'SALE_ALREADY_VOIDED' });
      expect((await runIntegrityChecks(e.db.pool)).violations).toEqual([]);
    } finally { await e.db.drop(); }
  });

  it('validates the request, and a void cannot be approved by the person asking', async () => {
    const sale = await sell(env);
    const base = { saleId: sale.id, reason: 'x', actor: 'cara', ...MANAGER };
    await expect(voidSale(pos(env), { ...base, reason: ' ' })).rejects.toMatchObject({ code: 'VOID_REASON_REQUIRED' });
    await expect(voidSale(pos(env), { ...base, approver: '' })).rejects.toMatchObject({ code: 'VOID_NEEDS_APPROVER' });
    await expect(voidSale(pos(env), { ...base, approver: 'cara' })).rejects.toMatchObject({ code: 'VOID_SELF_APPROVAL' });
    await expect(voidSale(pos(env), { ...base, approverRole: 'cashier' })).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
    await expect(voidSale(pos(env), { ...base, saleId: 999_999 })).rejects.toMatchObject({ code: 'SALE_NOT_FOUND' });
    expect((await getSale(env.db.pool, sale.id))!.status).toBe('completed');
  });

  it('after close-out a sale can no longer be voided (refund it instead), and a refunded sale cannot be voided', async () => {
    const e = await makeEnv();
    try {
      const s = await till(e, 'wes', 0);
      const sale = await sell(e, { cashier: 'wes' });
      const other = await sell(e, { cashier: 'wes' });
      await refundSale(pos(e), { saleId: other.id, items: [{ saleItemId: other.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'size', actor: 'wes', ...MANAGER });
      await expect(voidSale(pos(e), { saleId: other.id, reason: 'x', actor: 'wes', ...MANAGER })).rejects.toMatchObject({ code: 'SALE_HAS_REFUNDS' });
      await closeSession(pos(e), { sessionId: s.id, actor: 'wes', counted: { cash: 150_000, card: 0, mobile_money: 0 } });
      await expect(voidSale(pos(e), { saleId: sale.id, reason: 'x', actor: 'wes', ...MANAGER })).rejects.toMatchObject({ code: 'SESSION_CLOSED_USE_REFUND' });
    } finally { await e.db.drop(); }
  });
});

describe('refunding', () => {
  it('refunds chosen lines, pays back by cash, and reverses the discount\'s share', async () => {
    const e = await makeEnv();
    try {
      await till(e, 'rae', 300_000);
      const sale = await sell(e, { cashier: 'rae', units: 4, unitPrice: 25_000, saleDiscountCents: 5_000, discountReason: 'loyalty' }); // gross 100,000, discount 5,000, total 95,000
      const tillBefore = await accountBalance(e.db.pool, 'TILL');
      const r = await refundSale(pos(e), { saleId: sale.id, items: [{ saleItemId: sale.items[0]!.id, quantity: 2 }], method: 'cash', reason: 'Faulty', actor: 'rae', ...MANAGER });
      expect(r).toMatchObject({ grossCents: 50_000, discountCents: 2_500, amountCents: 47_500, method: 'cash' });
      expect(await accountBalance(e.db.pool, 'TILL')).toBe(tillBefore - 47_500);
      expect(r.sale.items[0]!.refundedQuantity).toBe(2);
      expect(r.sale.refundedCents).toBe(47_500);
      expect((await trialBalance(e.db.pool)).totalCents).toBe(0);
      expect((await runIntegrityChecks(e.db.pool)).violations).toEqual([]);
    } finally { await e.db.drop(); }
  });

  it('refunding every unit in pieces returns EXACTLY what was paid, never a cent more or less (with line AND sale discounts)', async () => {
    const e = await makeEnv();
    try {
      await till(e, 'rae', 5_000_000);
      for (const [units, unitPrice, lineDisc, saleDisc] of [[3, 33_333, 1_001, 777], [7, 12_345, 0, 1_234], [5, 99_999, 4_999, 2_501], [1, 10_001, 3, 7]] as const) {
        const sale = await sell(e, { cashier: 'rae', items: [{ name: 'X', quantity: units, unitPriceCents: unitPrice, discountCents: lineDisc }], saleDiscountCents: saleDisc, discountReason: 'bulk_purchase', cashierRole: 'admin' });
        let back = 0;
        for (let i = 0; i < units; i++) {
          back += (await refundSale(pos(e), { saleId: sale.id, items: [{ saleItemId: sale.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'piece by piece', actor: 'rae', ...MANAGER })).amountCents;
        }
        expect(back, `${units}x${unitPrice}`).toBe(sale.totalCents);
      }
      expect(await accountBalance(e.db.pool, 'SALES')).toBe(0);
      expect(await accountBalance(e.db.pool, 'SALES_DISCOUNTS')).toBe(0);
      expect((await runIntegrityChecks(e.db.pool)).violations).toEqual([]);
    } finally { await e.db.drop(); }
  }, 60_000);

  it('cannot refund more than was sold, more than was paid by that method, or a method the customer did not use', async () => {
    const e = await makeEnv();
    try {
      await till(e, 'rae', 1_000_000);
      const sale = await sell(e, { cashier: 'rae', units: 2, unitPrice: 50_000, payments: [{ method: 'cash', amountCents: 30_000 }, { method: 'mobile_money', amountCents: 70_000, reference: 'QXY7777777' }] });
      const item = sale.items[0]!.id;
      const base = { saleId: sale.id, reason: 'x', actor: 'rae', ...MANAGER };
      await expect(refundSale(pos(e), { ...base, items: [{ saleItemId: item, quantity: 3 }], method: 'mobile_money' })).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_SOLD' });
      await expect(refundSale(pos(e), { ...base, items: [{ saleItemId: item, quantity: 1 }], method: 'card' })).rejects.toMatchObject({ code: 'REFUND_METHOD_NOT_USED' });
      await expect(refundSale(pos(e), { ...base, items: [{ saleItemId: item, quantity: 1 }], method: 'cash' })).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAID' }); // 50,000 > the 30,000 paid in cash
      await refundSale(pos(e), { ...base, items: [{ saleItemId: item, quantity: 1 }], method: 'mobile_money' });
      await refundSale(pos(e), { ...base, items: [{ saleItemId: item, quantity: 1 }], method: 'mobile_money' }).then(() => { throw new Error('should have failed'); }, (err) => expect(err.code).toBe('REFUND_EXCEEDS_PAID'));
      await expect(refundSale(pos(e), { ...base, items: [{ saleItemId: item, quantity: 2 }], method: 'mobile_money' })).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_SOLD' });
      await expect(refundSale(pos(e), { ...base, items: [{ saleItemId: 999_999, quantity: 1 }], method: 'cash' })).rejects.toMatchObject({ code: 'SALE_ITEM_NOT_FOUND' });
    } finally { await e.db.drop(); }
  });

  it('needs a reason, a different approver who can approve, items, and the refunder\'s own open till', async () => {
    const sale = await sell(env);
    const item = sale.items[0]!.id;
    const base = { saleId: sale.id, items: [{ saleItemId: item, quantity: 1 }], method: 'cash' as const, reason: 'x', actor: 'cara', ...MANAGER };
    await expect(refundSale(pos(env), { ...base, reason: ' ' })).rejects.toMatchObject({ code: 'REFUND_REASON_REQUIRED' });
    await expect(refundSale(pos(env), { ...base, approver: 'cara' })).rejects.toMatchObject({ code: 'REFUND_SELF_APPROVAL' });
    await expect(refundSale(pos(env), { ...base, approverRole: 'cashier' })).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
    await expect(refundSale(pos(env), { ...base, items: [] })).rejects.toMatchObject({ code: 'REFUND_NO_ITEMS' });
    await expect(refundSale(pos(env), { ...base, items: [{ saleItemId: item, quantity: 0 }] })).rejects.toMatchObject({ code: 'REFUND_BAD_QUANTITY' });
    await expect(refundSale(pos(env), { ...base, actor: 'no-till-person' })).rejects.toMatchObject({ code: 'NO_OPEN_SESSION' });
    await expect(refundSale(pos(env), { ...base, saleId: 999_999 })).rejects.toMatchObject({ code: 'SALE_NOT_FOUND' });
  });

  it('a cash refund cannot take out more cash than the drawer should hold; a voided sale cannot be refunded', async () => {
    const e = await makeEnv();
    try {
      await till(e, 'rae', 0);
      const sale = await sell(e, { cashier: 'rae', units: 1, unitPrice: 40_000 });
      // empty the drawer with an approved drop, then try to refund cash
      const { recordCashMovement } = await import('../src/pos/sessions.js');
      const sid = (await e.db.pool.query(`SELECT id FROM cash_sessions WHERE cashier = 'rae'`)).rows[0].id;
      await recordCashMovement(pos(e), { sessionId: sid, kind: 'drop', amountCents: 40_000, reason: 'To the safe', requestedBy: 'rae', approvedBy: 'mona', approverRole: 'manager' });
      await expect(refundSale(pos(e), { saleId: sale.id, items: [{ saleItemId: sale.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'x', actor: 'rae', ...MANAGER })).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH' });
      const other = await sell(e, { cashier: 'rae' });
      await voidSale(pos(e), { saleId: other.id, reason: 'x', actor: 'rae', ...MANAGER });
      await expect(refundSale(pos(e), { saleId: other.id, items: [{ saleItemId: other.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'x', actor: 'rae', ...MANAGER })).rejects.toMatchObject({ code: 'SALE_NOT_REFUNDABLE' });
    } finally { await e.db.drop(); }
  });

  it('two people refunding the last unit at once refund it once', async () => {
    const e = await makeEnv();
    try {
      await till(e, 'rae', 500_000);
      const sale = await sell(e, { cashier: 'rae', units: 1, unitPrice: 50_000 });
      const results = await Promise.allSettled([1, 2, 3].map(() => refundSale(pos(e), { saleId: sale.id, items: [{ saleItemId: sale.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'race', actor: 'rae', ...MANAGER })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'REFUND_EXCEEDS_SOLD' });
    } finally { await e.db.drop(); }
  });
});
