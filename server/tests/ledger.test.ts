import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { allocateOrderRef } from '../src/ledger/refs.js';
import { accountBalance, cr, dr, getEntry, postEntry, reverseEntry, trialBalance } from '../src/ledger/ledger.js';
import { makeTestDb, type TestDb } from './helpers.js';

const KEY = 'test-key-for-order-refs-0123456789abcdef';
let db: TestDb;
let ref: string;

beforeAll(async () => {
  db = await makeTestDb();
  await runMigrations(db.pool);
  ref = (await allocateOrderRef(db.pool, { key: KEY })).ref;
});
afterAll(() => db.drop());

// Raw SQL that deliberately bypasses the service, to prove the DATABASE itself enforces the rule.
async function rawEntry(lines: [string, number][], orderRef: string | null = null) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const e = await c.query(`INSERT INTO journal_entries (description, actor, order_ref) VALUES ('raw', 'test', $1) RETURNING id`, [orderRef]);
    for (const [code, cents] of lines) {
      await c.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) SELECT $1, id, $3 FROM accounts WHERE code = $2`, [e.rows[0].id, code, cents]);
    }
    await c.query('COMMIT');
    return e.rows[0].id as number;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { c.release(); }
}

describe('Rule 1: every ledger entry balances to zero', () => {
  it('posts a balanced entry and reads it back', async () => {
    const { entry, replayed } = await postEntry(db.pool, {
      description: 'Customer pays paybill', actor: 'test', orderRef: ref,
      lines: [dr('PAYBILL_CLEARING', 150_000), cr('CUSTOMER_RECEIVABLE', 150_000)],
    });
    expect(replayed).toBe(false);
    expect(entry.lines).toEqual([
      { account: 'PAYBILL_CLEARING', amountCents: 150_000 },
      { account: 'CUSTOMER_RECEIVABLE', amountCents: -150_000 },
    ]);
  });

  it('supports entries with more than two lines', async () => {
    const { entry } = await postEntry(db.pool, {
      description: 'Split', actor: 'test',
      lines: [dr('BANK', 100), dr('TILL', 50), cr('SALES', 150)],
    });
    expect(entry.lines).toHaveLength(3);
  });

  it('the service refuses an unbalanced entry with a clear error and posts nothing', async () => {
    const before = (await db.pool.query('SELECT count(*)::bigint AS n FROM journal_entries')).rows[0].n;
    await expect(postEntry(db.pool, { description: 'bad', actor: 'test', lines: [dr('BANK', 100), cr('SALES', 99)] }))
      .rejects.toMatchObject({ code: 'LEDGER_UNBALANCED' });
    expect((await db.pool.query('SELECT count(*)::bigint AS n FROM journal_entries')).rows[0].n).toBe(before);
  });

  it('the service refuses a one-line entry, a zero line, a fractional amount and an unknown account', async () => {
    await expect(postEntry(db.pool, { description: 'x', actor: 't', lines: [dr('BANK', 100)] })).rejects.toMatchObject({ code: 'LEDGER_TOO_FEW_LINES' });
    await expect(postEntry(db.pool, { description: 'x', actor: 't', lines: [dr('BANK', 0), cr('SALES', 0)] })).rejects.toMatchObject({ code: 'LEDGER_ZERO_LINE' });
    await expect(postEntry(db.pool, { description: 'x', actor: 't', lines: [dr('BANK', 10.5), cr('SALES', 10.5)] })).rejects.toMatchObject({ code: 'LEDGER_BAD_AMOUNT' });
    await expect(postEntry(db.pool, { description: 'x', actor: 't', lines: [dr('NOPE', 5), cr('SALES', 5)] })).rejects.toMatchObject({ code: 'LEDGER_UNKNOWN_ACCOUNT' });
  });

  it('THE DATABASE refuses unbalanced lines even when the service is bypassed', async () => {
    await expect(rawEntry([['BANK', 100], ['SALES', -99]])).rejects.toThrow(/does not balance/);
  });

  it('THE DATABASE refuses an entry with a single line, and an entry with no lines at all', async () => {
    await expect(rawEntry([['BANK', 100]])).rejects.toThrow(/at least two lines/);
    await expect(rawEntry([])).rejects.toThrow(/at least two lines/);
  });

  it('THE DATABASE refuses a zero-amount line', async () => {
    await expect(rawEntry([['BANK', 0], ['SALES', 0]])).rejects.toThrow();
  });

  it('a failed entry leaves no partial rows behind', async () => {
    const lines = (await db.pool.query('SELECT count(*)::bigint AS n FROM journal_lines')).rows[0].n;
    await rawEntry([['BANK', 100], ['SALES', -99]]).catch(() => undefined);
    expect((await db.pool.query('SELECT count(*)::bigint AS n FROM journal_lines')).rows[0].n).toBe(lines);
  });

  it('lines cannot be added to an entry that is already posted', async () => {
    const { entry } = await postEntry(db.pool, { description: 'posted', actor: 't', lines: [dr('BANK', 10), cr('SALES', 10)] });
    await expect(db.pool.query(
      `INSERT INTO journal_lines (entry_id, account_id, amount_cents)
       SELECT $1::bigint, id, 5::bigint FROM accounts WHERE code = 'BANK' UNION ALL SELECT $1::bigint, id, -5::bigint FROM accounts WHERE code = 'SALES'`, [entry.id]))
      .rejects.toThrow(/already posted/);
  });

  it('the whole ledger always sums to zero', async () => {
    const tb = await trialBalance(db.pool);
    expect(tb.totalCents).toBe(0);
  });
});

describe('Rule 7: money records are immutable; corrections are reversing entries', () => {
  let entryId: number;
  beforeAll(async () => {
    entryId = (await postEntry(db.pool, {
      description: 'Immutable subject', actor: 't', orderRef: ref,
      lines: [dr('CUSTOMER_RECEIVABLE', 2_000), cr('SALES', 2_000)],
    })).entry.id;
  });

  it.each([
    ['UPDATE journal_entries', `UPDATE journal_entries SET description = 'edited'`],
    ['DELETE journal_entries', `DELETE FROM journal_entries`],
    ['UPDATE journal_lines', `UPDATE journal_lines SET amount_cents = amount_cents + 1`],
    ['DELETE journal_lines', `DELETE FROM journal_lines`],
    ['TRUNCATE journal_entries', `TRUNCATE journal_entries CASCADE`],
    ['TRUNCATE journal_lines', `TRUNCATE journal_lines`],
    ['UPDATE order_refs', `UPDATE order_refs SET ref = ref`],
    ['DELETE order_refs', `DELETE FROM order_refs`],
    ['TRUNCATE order_refs', `TRUNCATE order_refs CASCADE`],
  ])('refuses %s', async (_name, sql) => {
    await expect(db.pool.query(sql)).rejects.toThrow(/immutable/);
  });

  it('an account\'s code and type can never change, and it can never be deleted', async () => {
    await expect(db.pool.query(`UPDATE accounts SET code = 'X' WHERE code = 'BANK'`)).rejects.toThrow(/never change/);
    await expect(db.pool.query(`UPDATE accounts SET type = 'expense' WHERE code = 'BANK'`)).rejects.toThrow(/never change/);
    await expect(db.pool.query(`DELETE FROM accounts WHERE code = 'BANK'`)).rejects.toThrow(/cannot be deleted/);
  });

  it('a correction is a reversing entry that exactly negates the original and leaves it untouched', async () => {
    const before = await getEntry(db.pool, entryId);
    const rev = await reverseEntry(db.pool, { entryId, reason: 'Posted to wrong order', actor: 'manager-1' });

    expect(rev.reversesEntryId).toBe(entryId);
    expect(rev.reason).toBe('Posted to wrong order');
    expect(rev.actor).toBe('manager-1');
    expect(rev.orderRef).toBe(ref);
    expect(rev.lines).toEqual(before!.lines.map((l) => ({ account: l.account, amountCents: -l.amountCents })));
    expect(await getEntry(db.pool, entryId)).toEqual(before); // the original is byte-for-byte unchanged
  });

  it('after a reversal, the order\'s net effect on those accounts is zero', async () => {
    const own = await allocateOrderRef(db.pool, { key: KEY });
    const e = await postEntry(db.pool, { description: 'net', actor: 't', orderRef: own.ref, lines: [dr('TILL', 700), cr('SALES', 700)] });
    expect(await accountBalance(db.pool, 'TILL', { orderRef: own.ref })).toBe(700);
    await reverseEntry(db.pool, { entryId: e.entry.id, reason: 'duplicate', actor: 'm' });
    expect(await accountBalance(db.pool, 'TILL', { orderRef: own.ref })).toBe(0);
    expect(await accountBalance(db.pool, 'SALES', { orderRef: own.ref })).toBe(0);
  });

  it('an entry can be reversed only once, and a reversal cannot be reversed', async () => {
    const e = await postEntry(db.pool, { description: 'once', actor: 't', lines: [dr('BANK', 5), cr('SALES', 5)] });
    const rev = await reverseEntry(db.pool, { entryId: e.entry.id, reason: 'oops', actor: 'm' });
    await expect(reverseEntry(db.pool, { entryId: e.entry.id, reason: 'again', actor: 'm' })).rejects.toMatchObject({ code: 'LEDGER_ALREADY_REVERSED' });
    await expect(reverseEntry(db.pool, { entryId: rev.id, reason: 'undo the undo', actor: 'm' })).rejects.toMatchObject({ code: 'LEDGER_CANNOT_REVERSE_REVERSAL' });
  });

  it('concurrent reversals of one entry produce exactly one reversal', async () => {
    const e = await postEntry(db.pool, { description: 'race', actor: 't', lines: [dr('BANK', 9), cr('SALES', 9)] });
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => reverseEntry(db.pool, { entryId: e.entry.id, reason: 'race', actor: 'm' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const n = (await db.pool.query('SELECT count(*)::int AS n FROM journal_entries WHERE reverses_entry_id = $1', [e.entry.id])).rows[0].n;
    expect(n).toBe(1);
  });

  it('requires a reason and an actor, and 404s on an unknown entry', async () => {
    await expect(reverseEntry(db.pool, { entryId, reason: '   ', actor: 'm' })).rejects.toMatchObject({ code: 'LEDGER_REASON_REQUIRED' });
    await expect(reverseEntry(db.pool, { entryId: 987654, reason: 'x', actor: 'm' })).rejects.toMatchObject({ code: 'LEDGER_ENTRY_NOT_FOUND' });
    await expect(postEntry(db.pool, { description: 'x', actor: '  ', lines: [dr('BANK', 1), cr('SALES', 1)] })).rejects.toMatchObject({ code: 'LEDGER_NO_ACTOR' });
  });

  it('THE DATABASE requires a reason on any reversal, even when written by hand', async () => {
    const e = await postEntry(db.pool, { description: 'hand', actor: 't', lines: [dr('BANK', 3), cr('SALES', 3)] });
    await expect(db.pool.query(
      `INSERT INTO journal_entries (description, actor, reverses_entry_id) VALUES ('rev', 'x', $1)`, [e.entry.id]))
      .rejects.toThrow(/reversal_needs_reason/);
  });

  it('an entry cannot point at an order reference that does not exist', async () => {
    await expect(postEntry(db.pool, { description: 'x', actor: 't', orderRef: 'UT-22222222', lines: [dr('BANK', 1), cr('SALES', 1)] }))
      .rejects.toMatchObject({ code: 'LEDGER_UNKNOWN_ORDER_REF' });
  });
});

describe('idempotent posting', () => {
  it('the same key and content returns the original entry and posts once', async () => {
    const input = { description: 'webhook', actor: 'mpesa', idempotencyKey: 'mpesa-ABC12345', lines: [dr('PAYBILL_CLEARING', 400), cr('SUSPENSE', 400)] };
    const first = await postEntry(db.pool, input);
    const second = await postEntry(db.pool, input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = 'mpesa-ABC12345'`)).rows[0].n).toBe(1);
  });

  it('the same key with different content is refused, not silently ignored', async () => {
    await postEntry(db.pool, { description: 'a', actor: 't', idempotencyKey: 'key-conflict-1', lines: [dr('BANK', 1), cr('SALES', 1)] });
    await expect(postEntry(db.pool, { description: 'a', actor: 't', idempotencyKey: 'key-conflict-1', lines: [dr('BANK', 2), cr('SALES', 2)] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('simultaneous retries with one key post exactly once', async () => {
    const input = { description: 'burst', actor: 't', idempotencyKey: 'burst-key-0001', lines: [dr('BANK', 77), cr('SALES', 77)] };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => postEntry(db.pool, input)));
    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});
