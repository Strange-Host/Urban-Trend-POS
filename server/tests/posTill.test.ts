import { afterAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { moneyAtRisk } from '../src/orders/atRisk.js';
import { closeSession, expectedByMethod, getSession, openSession, recordCashMovement, signOffSession } from '../src/pos/sessions.js';
import { MANAGER, makeEnv, pos, sell, till, type Env } from './posHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };
const move = (e: Env, sessionId: number, over: Partial<Parameters<typeof recordCashMovement>[1]> = {}) =>
  recordCashMovement(pos(e), { sessionId, kind: 'paid_out', amountCents: 5_000, reason: 'Bought cleaning supplies', requestedBy: 'cara', approvedBy: 'mona', approverRole: 'manager', ...over });

describe('cash movements: paid-outs, drops and top-ups', () => {
  it('post to the ledger and change what the drawer should hold', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 100_000);
    expect((await expectedByMethod(e.db.pool, s.id)).cash).toBe(100_000);
    await move(e, s.id, { kind: 'paid_out', amountCents: 5_000 });
    expect(await accountBalance(e.db.pool, 'PETTY_EXPENSES')).toBe(5_000);
    const drop = await move(e, s.id, { kind: 'drop', amountCents: 40_000, reason: 'Too much cash in the drawer' });
    expect(drop.expectedCashCents).toBe(55_000);
    expect(await accountBalance(e.db.pool, 'SAFE')).toBe(-100_000 + 40_000); // 100,000 came out of the safe as float; 40,000 went back
    const up = await move(e, s.id, { kind: 'top_up', amountCents: 10_000, reason: 'Float for change' });
    expect(up.expectedCashCents).toBe(65_000);
    expect(await accountBalance(e.db.pool, 'TILL')).toBe(65_000);
    expect((await trialBalance(e.db.pool)).totalCents).toBe(0);
    expect((await runIntegrityChecks(e.db.pool)).violations).toEqual([]);
  });

  it('need a reason and a SECOND person who is allowed to approve', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 100_000);
    await expect(move(e, s.id, { reason: ' ' })).rejects.toMatchObject({ code: 'MOVEMENT_REASON_REQUIRED' });
    await expect(move(e, s.id, { approvedBy: 'cara' })).rejects.toMatchObject({ code: 'MOVEMENT_SELF_APPROVAL' });
    await expect(move(e, s.id, { approvedBy: '' })).rejects.toMatchObject({ code: 'MOVEMENT_NEEDS_APPROVER' });
    await expect(move(e, s.id, { approverRole: 'cashier' })).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
    await expect(move(e, s.id, { amountCents: 0 })).rejects.toMatchObject({ code: 'MOVEMENT_BAD_AMOUNT' });
    // @ts-expect-error: not a real kind
    await expect(move(e, s.id, { kind: 'gift' })).rejects.toMatchObject({ code: 'MOVEMENT_BAD_KIND' });
    await expect(env_db_requires_two(e, s.id)).resolves.toBeUndefined();
    await expect(move(e, 999_999)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect((await e.db.pool.query('SELECT count(*)::int AS n FROM cash_movements WHERE kind <> \'top_up\'')).rows[0].n).toBe(0);
  });

  it('cannot take out more cash than the drawer should hold, but a top-up always can go in', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 10_000);
    await expect(move(e, s.id, { amountCents: 10_001 })).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH' });
    await expect(move(e, s.id, { kind: 'drop', amountCents: 10_001 })).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH' });
    await expect(move(e, s.id, { amountCents: 10_000 })).resolves.toBeDefined();
    await expect(move(e, s.id, { kind: 'top_up', amountCents: 1_000_000 })).resolves.toBeDefined();
  });

  it('cannot be recorded against a closed session, and are never edited or deleted', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 10_000);
    const m = await move(e, s.id, { amountCents: 1_000 });
    await expect(e.db.pool.query(`UPDATE cash_movements SET amount_cents = 1 WHERE id = $1`, [m.id])).rejects.toThrow(/immutable/);
    await expect(e.db.pool.query(`DELETE FROM cash_movements WHERE id = $1`, [m.id])).rejects.toThrow(/immutable/);
    await expect(e.db.pool.query(`UPDATE cash_movements SET approved_by = requested_by WHERE id = $1`, [m.id])).rejects.toThrow();
    await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 9_000, card: 0, mobile_money: 0 } });
    await expect(move(e, s.id, { amountCents: 1 })).rejects.toMatchObject({ code: 'SESSION_NOT_OPEN' });
  });
});
async function env_db_requires_two(e: Env, sessionId: number) {
  // the database refuses a movement approved by its own requester, even if the service is bypassed
  const entry = (await e.db.pool.query(`SELECT id FROM journal_entries ORDER BY id LIMIT 1`)).rows[0].id;
  await expect(e.db.pool.query(
    `INSERT INTO cash_movements (session_id, kind, amount_cents, reason, requested_by, approved_by, entry_id) VALUES ($1, 'paid_out', 1, 'x', 'same', 'same', $2)`, [sessionId, entry])).rejects.toThrow(/approver_is_someone_else/);
}

describe('close-out', () => {
  it('a count that matches posts nothing and closes the session', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 50_000);
    await sell(e, { units: 1, unitPrice: 20_000 });
    await sell(e, { units: 1, unitPrice: 60_000, payments: [{ method: 'card', amountCents: 60_000, reference: 'AUTH1' }] });
    const entries = (await e.db.pool.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n;
    const r = await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 70_000, card: 60_000, mobile_money: 0 } });
    expect(r.totalAbsVarianceCents).toBe(0);
    expect(r.session).toMatchObject({ status: 'closed', signoffRequired: false });
    expect(r.counts.map((c) => [c.method, c.expectedCents, c.countedCents, c.varianceCents])).toEqual([['cash', 70_000, 70_000, 0], ['card', 60_000, 60_000, 0], ['mobile_money', 0, 0, 0]]);
    expect((await e.db.pool.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(entries);
  });

  it('compares each method separately and needs every count (zero if there was none)', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 0);
    // @ts-expect-error: a count is missing
    await expect(closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 0, card: 0 } })).rejects.toMatchObject({ code: 'COUNT_MISSING' });
    await expect(closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 0, card: -1, mobile_money: 0 } })).rejects.toMatchObject({ code: 'COUNT_MISSING' });
    expect((await getSession(e.db.pool, s.id))!.status).toBe('open');
  });

  it('a difference needs a reason, and says what was expected', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 50_000);
    await expect(closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 49_000, card: 0, mobile_money: 0 } })).rejects.toMatchObject({ code: 'VARIANCE_REASON_REQUIRED' });
    await expect(closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 49_000, card: 0, mobile_money: 0 }, varianceReason: '  ' })).rejects.toMatchObject({ code: 'VARIANCE_REASON_REQUIRED' });
    expect((await getSession(e.db.pool, s.id))!.status).toBe('open');
  });

  it('a shortage and an overage post to the ledger so the books match the count, method by method', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 100_000);
    await sell(e, { units: 1, unitPrice: 30_000, payments: [{ method: 'mobile_money', amountCents: 30_000, reference: 'QXY1' }] });
    await sell(e, { units: 1, unitPrice: 20_000, payments: [{ method: 'card', amountCents: 20_000, reference: 'AUTH2' }] });
    const [t, c, m] = await Promise.all(['TILL', 'CARD_CLEARING', 'MOBILE_MONEY_TILL'].map((a) => accountBalance(e.db.pool, a)));
    const r = await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 98_500, card: 20_500, mobile_money: 30_000 }, varianceReason: 'Short 1,500 cash; card slip total 500 higher' });
    expect(r.counts.map((x) => x.varianceCents)).toEqual([-1_500, 500, 0]);
    expect(await accountBalance(e.db.pool, 'TILL')).toBe(t! - 1_500);
    expect(await accountBalance(e.db.pool, 'CARD_CLEARING')).toBe(c! + 500);
    expect(await accountBalance(e.db.pool, 'MOBILE_MONEY_TILL')).toBe(m);
    expect(await accountBalance(e.db.pool, 'CASH_OVER_SHORT')).toBe(1_500 - 500);   // net shortage of 1,000
    expect((await trialBalance(e.db.pool)).totalCents).toBe(0);
    expect((await runIntegrityChecks(e.db.pool)).violations).toEqual([]);
  });

  it('a large difference (over KES 500) needs a manager\'s sign-off; exactly KES 500 does not; the threshold is adjustable', async () => {
    const e = await fresh();
    const a = await till(e, 'cara', 100_000);
    const atLimit = await closeSession(pos(e), { sessionId: a.id, actor: 'cara', counted: { cash: 50_000, card: 0, mobile_money: 0 }, varianceReason: 'short by exactly KES 500' });
    expect(atLimit.totalAbsVarianceCents).toBe(50_000);
    expect(atLimit.session.signoffRequired).toBe(false);
    const b = await till(e, 'dan', 100_000);
    const over = await closeSession(pos(e), { sessionId: b.id, actor: 'dan', counted: { cash: 49_999, card: 0, mobile_money: 0 }, varianceReason: 'one cent over the limit' });
    expect(over.session).toMatchObject({ status: 'closed', signoffRequired: true });
    const c = await till(e, 'eve', 100_000);
    const lenient = await closeSession({ pool: e.db.pool, signoffThresholdCents: 500_000 }, { sessionId: c.id, actor: 'eve', counted: { cash: 40_000, card: 0, mobile_money: 0 }, varianceReason: 'x' }); // 60,000 out
    expect(lenient.session.signoffRequired).toBe(false);
    // differences in several methods add up (as absolute amounts) toward the threshold
    const f = await till(e, 'fay', 0);
    await sell(e, { cashier: 'fay', units: 1, unitPrice: 100_000, payments: [{ method: 'card', amountCents: 60_000, reference: 'A1' }, { method: 'mobile_money', amountCents: 40_000, reference: 'Q1' }] });
    const mixed = await closeSession(pos(e), { sessionId: f.id, actor: 'fay', counted: { cash: 0, card: 30_000, mobile_money: 80_000 }, varianceReason: 'card short, mobile over' }); // -30,000 and +40,000 = 70,000 absolute
    expect(mixed.totalAbsVarianceCents).toBe(70_000);
    expect(mixed.session.signoffRequired).toBe(true);
  });

  it('sign-off: only for sessions that need it, by an approver who is not the cashier, once', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 100_000);
    const ok = await till(e, 'dan', 0);
    await closeSession(pos(e), { sessionId: ok.id, actor: 'dan', counted: { cash: 0, card: 0, mobile_money: 0 } });
    await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 30_000, card: 0, mobile_money: 0 }, varianceReason: 'Cash went missing' });
    await expect(signOffSession(pos(e), { sessionId: ok.id, ...MANAGER })).rejects.toMatchObject({ code: 'SIGNOFF_NOT_NEEDED' });
    await expect(signOffSession(pos(e), { sessionId: s.id, approver: 'cara', approverRole: 'manager' })).rejects.toMatchObject({ code: 'SIGNOFF_SELF' });
    await expect(signOffSession(pos(e), { sessionId: s.id, approver: 'x', approverRole: 'cashier' })).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
    await expect(signOffSession(pos(e), { sessionId: s.id, approver: ' ', approverRole: 'manager' })).rejects.toMatchObject({ code: 'SIGNOFF_NO_APPROVER' });
    await expect(signOffSession(pos(e), { sessionId: 999_999, ...MANAGER })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect((await signOffSession(pos(e), { sessionId: s.id, ...MANAGER })).status).toBe('signed_off');
    await expect(signOffSession(pos(e), { sessionId: s.id, ...MANAGER })).rejects.toMatchObject({ code: 'SESSION_ALREADY_SIGNED_OFF' });
  });

  it('only the cashier closes their own session, once; a closed session cannot sell, and nothing about it can be changed', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 10_000);
    await expect(closeSession(pos(e), { sessionId: s.id, actor: 'dan', counted: { cash: 10_000, card: 0, mobile_money: 0 } })).rejects.toMatchObject({ code: 'SESSION_NOT_YOURS' });
    await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 10_000, card: 0, mobile_money: 0 } });
    await expect(closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 10_000, card: 0, mobile_money: 0 } })).rejects.toMatchObject({ code: 'SESSION_NOT_OPEN' });
    await expect(sell(e)).rejects.toMatchObject({ code: 'NO_OPEN_SESSION' });
    await expect(closeSession(pos(e), { sessionId: 999_999, actor: 'cara', counted: { cash: 0, card: 0, mobile_money: 0 } })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    const q = (sql: string) => e.db.pool.query(sql);
    await expect(q(`UPDATE cash_sessions SET status = 'open'`)).rejects.toThrow(/cannot be changed/);
    await expect(q(`UPDATE cash_sessions SET opening_float_cents = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(q(`DELETE FROM cash_sessions`)).rejects.toThrow(/cannot be deleted/);
    await expect(q(`UPDATE cash_session_counts SET counted_cents = 1, variance_cents = counted_cents`)).rejects.toThrow(/immutable/);
    await expect(q(`DELETE FROM cash_session_counts`)).rejects.toThrow(/immutable/);
    // closed, a cashier can open a fresh session
    expect((await openSession(pos(e), { cashier: 'cara', openingFloatCents: 0 })).status).toBe('open');
  });

  it('two attempts to close one session at once close it once', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 10_000);
    const results = await Promise.allSettled([1, 2, 3].map(() => closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 9_000, card: 0, mobile_money: 0 }, varianceReason: 'x' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'SESSION_NOT_OPEN' });
    expect(await accountBalance(e.db.pool, 'CASH_OVER_SHORT')).toBe(1_000); // the difference was posted once
  });
});

describe('the till on the money-at-risk page', () => {
  it('flags an out-of-balance close-out waiting for a manager, and a session left open', async () => {
    const e = await fresh();
    const a = await till(e, 'cara', 100_000);
    await closeSession(pos(e), { sessionId: a.id, actor: 'cara', counted: { cash: 30_000, card: 0, mobile_money: 0 }, varianceReason: 'Cash missing' });
    await till(e, 'dan', 0);
    const now = await moneyAtRisk(e.db.pool);
    expect(now.find((i) => i.kind === 'till_variance_unsigned')).toMatchObject({ owner: 'cara', amountCents: 70_000 });
    expect(now.some((i) => i.kind === 'till_session_left_open')).toBe(false); // just opened
    const later = await moneyAtRisk(e.db.pool, { now: new Date(Date.now() + 30 * 3_600_000) });
    expect(later.find((i) => i.kind === 'till_session_left_open')).toMatchObject({ owner: 'dan' });
    await signOffSession(pos(e), { sessionId: a.id, ...MANAGER });
    expect((await moneyAtRisk(e.db.pool)).some((i) => i.kind === 'till_variance_unsigned')).toBe(false);
  });
});
