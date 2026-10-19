import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/tx.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { msUntilNextRun, runNightlyIntegrity } from '../src/integrity/job.js';
import { cr, dr, postEntry, postEntryTx, reverseEntry } from '../src/ledger/ledger.js';
import { ALPHABET } from '../src/ledger/orderRef.js';
import { allocateOrderRef } from '../src/ledger/refs.js';
import { issueReceiptTx } from '../src/ledger/receipts.js';
import { createLogger } from '../src/logger.js';
import { makeTestDb, type TestDb } from './helpers.js';

const KEY = 'test-key-for-order-refs-0123456789abcdef';
const logger = createLogger('silent');
const dbs: TestDb[] = [];

// A database with some healthy history: refs, balanced entries, a reversal and gapless receipts.
async function healthyDb(): Promise<TestDb> {
  const db = await makeTestDb();
  dbs.push(db);
  await runMigrations(db.pool);
  for (let i = 0; i < 3; i++) {
    await withTransaction(db.pool, async (c) => {
      const { ref } = await allocateOrderRef(c, { key: KEY });
      const { entry } = await postEntryTx(c, { description: 'paid', actor: 't', orderRef: ref, lines: [dr('PAYBILL_CLEARING', 1000 + i), cr('CUSTOMER_RECEIVABLE', 1000 + i)] });
      await issueReceiptTx(c, { orderRef: ref, journalEntryId: entry.id, amountCents: 1000 + i, method: 'mpesa_paybill', actor: 't', at: new Date('2026-10-10T09:00:00Z') });
    });
  }
  const e = await postEntry(db.pool, { description: 'mistake', actor: 't', lines: [dr('BANK', 5), cr('SALES', 5)] });
  await reverseEntry(db.pool, { entryId: e.entry.id, reason: 'wrong', actor: 'm' });
  return db;
}

// Simulates the things the guards exist to stop (a bypassed trigger, a bad restore, a hand-run script).
async function asSuperuserBypassingGuards<T>(db: TestDb, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query('SET session_replication_role = replica'); // disables ALL triggers, including foreign keys
    return await fn(c);
  } finally {
    await c.query('RESET session_replication_role');
    c.release();
  }
}

afterAll(async () => { for (const d of dbs) await d.drop(); });

describe('integrity checks on healthy data', () => {
  it('pass, and report what they looked at', async () => {
    const db = await healthyDb();
    const report = await runIntegrityChecks(db.pool);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ entries: 5, lines: 10, orderRefs: 3, receipts: 3, orders: 0, payments: 0 });
  });

  it('pass on an empty database', async () => {
    const db = await makeTestDb();
    dbs.push(db);
    await runMigrations(db.pool);
    expect((await runIntegrityChecks(db.pool)).ok).toBe(true);
  });
});

describe('integrity checks catch corruption', () => {
  it('Rule 1: an entry that does not balance, or has too few lines, even when the guards were bypassed', async () => {
    const db = await healthyDb();
    await asSuperuserBypassingGuards(db, async (c) => {
      const e = await c.query(`INSERT INTO journal_entries (description, actor) VALUES ('corrupt', 'x') RETURNING id`);
      await c.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) SELECT $1, id, 100 FROM accounts WHERE code = 'BANK'`, [e.rows[0].id]);
      const lone = await c.query(`INSERT INTO journal_entries (description, actor) VALUES ('lonely', 'x') RETURNING id`);
      await c.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) SELECT $1, id, 7 FROM accounts WHERE code = 'BANK' UNION ALL SELECT $1, id, -5 FROM accounts WHERE code = 'SALES'`.replace(/\$1/g, '$1::bigint'), [lone.rows[0].id]);
    });
    const report = await runIntegrityChecks(db.pool);
    expect(report.ok).toBe(false);
    const rule1 = report.violations.filter((v) => v.rule === 1).map((v) => v.check);
    expect(rule1).toContain('entry_balances');
    expect(rule1).toContain('trial_balance');
    expect(report.violations.filter((v) => v.check === 'entry_balances')).toHaveLength(2);
  });

  it('Rule 7: a disabled protection trigger is itself reported', async () => {
    const db = await healthyDb();
    await db.pool.query('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_immutable');
    const report = await runIntegrityChecks(db.pool);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 7, check: 'guard_enabled', message: expect.stringContaining('journal_lines_immutable') })]);
  });

  it('Rule 7: a missing protection trigger is reported', async () => {
    const db = await healthyDb();
    await db.pool.query('DROP TRIGGER order_refs_immutable ON order_refs');
    const report = await runIntegrityChecks(db.pool);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 10, check: 'guard_present' })]);
  });

  it('Rule 7: a "reversal" that does not exactly negate its original', async () => {
    const db = await healthyDb();
    const original = await postEntry(db.pool, { description: 'orig', actor: 't', lines: [dr('BANK', 100), cr('SALES', 100)] });
    // Balanced, so the database accepts it, but it reverses only 90 of the 100.
    await db.pool.query(
      `WITH e AS (INSERT INTO journal_entries (description, actor, reverses_entry_id, reason) VALUES ('sloppy', 'x', $1, 'r') RETURNING id)
       INSERT INTO journal_lines (entry_id, account_id, amount_cents)
       SELECT e.id, a.id, v.amt FROM e, (VALUES ('BANK', -90::bigint), ('SALES', 90::bigint)) v(code, amt) JOIN accounts a ON a.code = v.code`, [original.entry.id]);
    const report = await runIntegrityChecks(db.pool);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 7, check: 'reversal_exact' })]);
  });

  it('Rule 10: an order reference whose check character is wrong', async () => {
    const db = await healthyDb();
    const { ref } = await allocateOrderRef(db.pool, { key: KEY });
    const bad = ref.slice(0, -1) + ALPHABET[(ALPHABET.indexOf(ref.at(-1)!) + 1) % 32];
    await db.pool.query(`INSERT INTO order_refs (ref) VALUES ($1)`, [bad]); // matches the format check, fails the check character
    const report = await runIntegrityChecks(db.pool);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 10, check: 'ref_format', ref: bad })]);
  });

  it('Rule 10: a ledger entry pointing at a reference that does not exist', async () => {
    const db = await healthyDb();
    await asSuperuserBypassingGuards(db, async (c) => {
      const e = await c.query(`INSERT INTO journal_entries (description, actor, order_ref) VALUES ('orphan', 'x', 'UT-22222222') RETURNING id`);
      await c.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) SELECT $1::bigint, id, 10 FROM accounts WHERE code = 'BANK' UNION ALL SELECT $1::bigint, id, -10 FROM accounts WHERE code = 'SALES'`, [e.rows[0].id]);
    });
    const report = await runIntegrityChecks(db.pool);
    expect(report.violations).toEqual([expect.objectContaining({ rule: 10, check: 'entry_ref_exists', ref: 'UT-22222222' })]);
  });

  it('receipts: a gap in the numbering, and a receipt that disagrees with its ledger entry', async () => {
    const db = await healthyDb();
    await asSuperuserBypassingGuards(db, async (c) => {
      await c.query(`DELETE FROM payment_receipts WHERE receipt_no = 'RC-2610-000002'`);
      const other = await allocateOrderRef(c, { key: KEY });
      await c.query(`UPDATE payment_receipts SET order_ref = $1 WHERE receipt_no = 'RC-2610-000003'`, [other.ref]);
    });
    const checks = (await runIntegrityChecks(db.pool)).violations.map((v) => v.check).sort();
    expect(checks).toEqual(['receipt_numbering', 'receipt_ref_matches_entry']);
  });
});

describe('nightly job', () => {
  it('records each run in integrity_runs', async () => {
    const db = await healthyDb();
    const result = await runNightlyIntegrity(db.pool, { logger });
    expect(result.ran).toBe(true);
    const runs = (await db.pool.query('SELECT ok, violations, counts FROM integrity_runs')).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: true, violations: [], counts: { entries: 5, receipts: 3 } });
  });

  it('stores failures with their details', async () => {
    const db = await healthyDb();
    await db.pool.query('ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_immutable');
    const result = await runNightlyIntegrity(db.pool, { logger });
    expect(result.ran && result.report.ok).toBe(false);
    const run = (await db.pool.query('SELECT ok, violations FROM integrity_runs')).rows[0];
    expect(run.ok).toBe(false);
    expect(run.violations[0]).toMatchObject({ rule: 7, check: 'guard_enabled' });
  });

  it('skips a second run soon after the first, unless forced', async () => {
    const db = await healthyDb();
    await runNightlyIntegrity(db.pool, { logger });
    expect(await runNightlyIntegrity(db.pool, { logger })).toEqual({ ran: false, skipped: 'ran recently' });
    expect((await runNightlyIntegrity(db.pool, { logger, force: true })).ran).toBe(true);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM integrity_runs')).rows[0].n).toBe(2);
  });

  it('lets only one instance run at a time', async () => {
    const db = await healthyDb();
    const holder = await db.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(727401002)'); // another instance mid-run
      expect(await runNightlyIntegrity(db.pool, { logger, force: true })).toEqual({ ran: false, skipped: 'another instance is running' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(727401002)');
      holder.release();
    }
    expect((await runNightlyIntegrity(db.pool, { logger, force: true })).ran).toBe(true);
  });
});

describe('schedule', () => {
  const mins = (ms: number) => Math.round(ms / 60_000);
  it('finds the next 02:00 East Africa Time (23:00 UTC the day before)', () => {
    expect(mins(msUntilNextRun(new Date('2026-10-18T10:00:00Z'), 2))).toBe(13 * 60);  // 13:00 EAT -> 02:00 tomorrow
    expect(mins(msUntilNextRun(new Date('2026-10-18T22:59:00Z'), 2))).toBe(1);        // 01:59 EAT
    expect(mins(msUntilNextRun(new Date('2026-10-18T23:00:00Z'), 2))).toBe(24 * 60);  // exactly 02:00 EAT: next one is tomorrow
    expect(mins(msUntilNextRun(new Date('2026-10-18T23:30:00Z'), 2))).toBe(24 * 60 - 30);
    expect(mins(msUntilNextRun(new Date('2026-12-31T21:00:00Z'), 0))).toBe(24 * 60);  // exactly 00:00 EAT
  });
});
