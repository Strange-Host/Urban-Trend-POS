import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db/tx.js';
import type { Queryable } from '../db/tx.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';

// Debits are positive cents, credits negative. Every entry's lines must sum to zero.
export interface LineInput {
  account: string;     // account code, e.g. 'CUSTOMER_RECEIVABLE'
  amountCents: number; // + debit, - credit
}
export const dr = (account: string, cents: number): LineInput => ({ account, amountCents: cents });
export const cr = (account: string, cents: number): LineInput => ({ account, amountCents: -cents });

export interface PostEntryInput {
  description: string;
  actor: string;
  orderRef?: string | null;
  /** The courier this entry concerns. Required for anything touching COURIER_PAYABLE or ORG_RECEIVABLE, so each courier's balance is read from the ledger. */
  courierId?: number | null;
  lines: LineInput[];
  /** Makes the post safe to retry: the same key and content returns the original entry instead of posting twice. */
  idempotencyKey?: string;
}

export interface Entry {
  id: number;
  postedAt: Date;
  description: string;
  orderRef: string | null;
  courierId: number | null;
  actor: string;
  reversesEntryId: number | null;
  reason: string | null;
  lines: { account: string; amountCents: number }[];
}

export interface PostResult { entry: Entry; replayed: boolean }

function validateLines(lines: LineInput[]): void {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new HttpError(422, 'LEDGER_TOO_FEW_LINES', 'A journal entry needs at least two lines.');
  }
  let total = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountCents)) throw new HttpError(422, 'LEDGER_BAD_AMOUNT', `Amount for ${l.account} must be a whole number of cents.`);
    if (l.amountCents === 0) throw new HttpError(422, 'LEDGER_ZERO_LINE', `A line for ${l.account} cannot be zero.`);
    total += l.amountCents;
  }
  if (total !== 0) {
    throw new HttpError(422, 'LEDGER_UNBALANCED', `Entry does not balance: lines sum to ${total} cents, not 0.`);
  }
}

const hashRequest = (i: PostEntryInput) =>
  createHash('sha256').update(JSON.stringify([i.description, i.orderRef ?? null, i.courierId ?? null, i.lines])).digest('hex');

interface EntryRow {
  id: number; posted_at: Date; description: string; order_ref: string | null; courier_id: number | null; actor: string;
  reverses_entry_id: number | null; reason: string | null; idempotency_hash?: string | null;
}

export async function getEntry(db: Queryable, id: number): Promise<Entry | null> {
  const e = await db.query<EntryRow>(
    `SELECT id, posted_at, description, order_ref, courier_id, actor, reverses_entry_id, reason FROM journal_entries WHERE id = $1`, [id]);
  if (!e.rows[0]) return null;
  const l = await db.query<{ code: string; amount_cents: number }>(
    `SELECT a.code, l.amount_cents FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.id`, [id]);
  const r = e.rows[0];
  return {
    id: r.id, postedAt: r.posted_at, description: r.description, orderRef: r.order_ref, courierId: r.courier_id, actor: r.actor,
    reversesEntryId: r.reverses_entry_id, reason: r.reason,
    lines: l.rows.map((x) => ({ account: x.code, amountCents: x.amount_cents })),
  };
}

async function insertEntry(
  client: pg.PoolClient,
  input: PostEntryInput,
  extra: { reversesEntryId?: number; reason?: string } = {},
): Promise<PostResult> {
  validateLines(input.lines);
  if (!input.description?.trim()) throw new HttpError(422, 'LEDGER_NO_DESCRIPTION', 'A journal entry needs a description.');
  if (!input.actor?.trim()) throw new HttpError(422, 'LEDGER_NO_ACTOR', 'A journal entry needs the person or system that posted it.');

  const codes = [...new Set(input.lines.map((l) => l.account))];
  const accts = await client.query<{ id: number; code: string }>(
    `SELECT id, code FROM accounts WHERE code = ANY($1) AND is_active`, [codes]);
  const ids = new Map(accts.rows.map((a) => [a.code, a.id]));
  const unknown = codes.filter((c) => !ids.has(c));
  if (unknown.length) throw new HttpError(422, 'LEDGER_UNKNOWN_ACCOUNT', `Unknown or inactive account: ${unknown.join(', ')}.`);

  const hash = input.idempotencyKey ? hashRequest(input) : null;
  const ins = await client.query<{ id: number }>(
    `INSERT INTO journal_entries (description, order_ref, actor, reverses_entry_id, reason, idempotency_key, idempotency_hash, courier_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.description.trim(), input.orderRef ?? null, input.actor.trim(), extra.reversesEntryId ?? null, extra.reason ?? null,
     input.idempotencyKey ?? null, hash, input.courierId ?? null],
  );

  if (!ins.rows[0]) {
    // Same idempotency key seen before: return the original, but only if this is genuinely the same request.
    const prior = await client.query<EntryRow>(
      `SELECT id, idempotency_hash FROM journal_entries WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (prior.rows[0]?.idempotency_hash !== hash) {
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'That idempotency key was already used for a different entry.');
    }
    return { entry: (await getEntry(client, prior.rows[0]!.id))!, replayed: true };
  }

  const entryId = ins.rows[0].id;
  const values: unknown[] = [];
  const tuples = input.lines.map((l, i) => {
    values.push(entryId, ids.get(l.account), l.amountCents);
    return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
  });
  await client.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) VALUES ${tuples.join(', ')}`, values);

  // Surface any balance failure here rather than at the caller's COMMIT.
  await client.query('SET CONSTRAINTS journal_lines_balanced, journal_entries_balanced IMMEDIATE');
  await client.query('SET CONSTRAINTS journal_lines_balanced, journal_entries_balanced DEFERRED');

  return { entry: (await getEntry(client, entryId))!, replayed: false };
}

function mapDbError(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === '23514') throw new HttpError(422, 'LEDGER_UNBALANCED', e.message ?? 'Entry does not balance.');
  if (e.code === '23503' && e.constraint?.includes('order_ref')) throw new HttpError(422, 'LEDGER_UNKNOWN_ORDER_REF', 'That order reference does not exist.');
  if (e.code === '23503' && e.constraint?.includes('courier')) throw new HttpError(422, 'LEDGER_UNKNOWN_COURIER', 'That courier does not exist.');
  throw err;
}

/** Posts an entry inside a transaction the caller already has open (so it commits or rolls back with their other work). */
export async function postEntryTx(client: pg.PoolClient, input: PostEntryInput): Promise<PostResult> {
  try { return await insertEntry(client, input); } catch (e) { return mapDbError(e); }
}

/** Posts an entry in its own transaction. */
export function postEntry(pool: Pool, input: PostEntryInput): Promise<PostResult> {
  return withTransaction(pool, (c) => postEntryTx(c, input)).catch(mapDbError);
}

/**
 * Corrects an entry the only allowed way: a new entry that exactly negates it, with a reason and an actor.
 * The original is never touched. An entry can be reversed once, and a reversal cannot itself be reversed
 * (post a fresh, correct entry instead).
 */
export function reverseEntry(pool: Pool, opts: { entryId: number; reason: string; actor: string }): Promise<Entry> {
  return withTransaction(pool, (client) => reverseEntryTx(client, opts)).catch(mapDbError);
}

/** Same as reverseEntry, inside a transaction the caller already has open (so it commits or rolls back with their other work). */
export async function reverseEntryTx(client: pg.PoolClient, opts: { entryId: number; reason: string; actor: string }): Promise<Entry> {
  if (!opts.reason?.trim()) throw new HttpError(422, 'LEDGER_REASON_REQUIRED', 'A reversal needs a reason.');
  try {
    const found = await client.query<EntryRow>(
      `SELECT id, order_ref, courier_id, reverses_entry_id FROM journal_entries WHERE id = $1 FOR UPDATE`, [opts.entryId]);
    const original = found.rows[0];
    if (!original) throw new HttpError(404, 'LEDGER_ENTRY_NOT_FOUND', 'Journal entry not found.');
    if (original.reverses_entry_id !== null) {
      throw new HttpError(409, 'LEDGER_CANNOT_REVERSE_REVERSAL', 'A reversal cannot be reversed; post a new, correct entry instead.');
    }
    const already = await client.query(`SELECT 1 FROM journal_entries WHERE reverses_entry_id = $1`, [opts.entryId]);
    if (already.rows[0]) throw new HttpError(409, 'LEDGER_ALREADY_REVERSED', 'This entry has already been reversed.');

    const orig = (await getEntry(client, opts.entryId))!;
    const { entry } = await insertEntry(client, {
      description: `Reversal of entry ${opts.entryId}: ${opts.reason.trim()}`,
      actor: opts.actor,
      orderRef: original.order_ref,
      courierId: original.courier_id,
      lines: orig.lines.map((l) => ({ account: l.account, amountCents: -l.amountCents })),
    }, { reversesEntryId: opts.entryId, reason: opts.reason.trim() });
    return entry;
  } catch (e) { return mapDbError(e); }
}

/** Signed balance of one account (debit positive) over every entry, or only those for one order. */
export async function accountBalance(db: Queryable, code: string, opts: { orderRef?: string } = {}): Promise<number> {
  const { rows } = await db.query<{ b: number }>(
    `SELECT COALESCE(sum(l.amount_cents), 0)::bigint AS b
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE a.code = $1 AND ($2::text IS NULL OR e.order_ref = $2)`, [code, opts.orderRef ?? null]);
  return rows[0]!.b;
}

export interface TrialBalanceRow { code: string; name: string; type: string; balanceCents: number }

export async function trialBalance(db: Queryable): Promise<{ rows: TrialBalanceRow[]; totalCents: number }> {
  const { rows } = await db.query<{ code: string; name: string; type: string; b: number }>(
    `SELECT a.code, a.name, a.type, COALESCE(sum(l.amount_cents), 0)::bigint AS b
       FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
      GROUP BY a.id ORDER BY a.code`);
  const mapped = rows.map((r) => ({ code: r.code, name: r.name, type: r.type, balanceCents: r.b }));
  return { rows: mapped, totalCents: mapped.reduce((s, r) => s + r.balanceCents, 0) };
}
