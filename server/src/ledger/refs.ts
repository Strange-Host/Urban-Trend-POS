import type { Queryable } from '../db/tx.js';
import { formatRef, keyFingerprint, normalizeLegacyRef, normalizeOrderRef } from './orderRef.js';

export interface OrderRefRow {
  ref: string;
  legacyRef: string | null;
  allocatedAt: Date;
}

interface Row { ref: string; legacy_ref: string | null; allocated_at: Date }
const toRow = (r: Row): OrderRefRow => ({ ref: r.ref, legacyRef: r.legacy_ref, allocatedAt: r.allocated_at });

// The key decides how sequence numbers are scrambled. Change it after references exist and new ones could collide
// with old ones, so the first allocation records a fingerprint and every later one must match it.
async function assertKeyUnchanged(db: Queryable, key: string): Promise<void> {
  const fp = keyFingerprint(key);
  await db.query(`INSERT INTO app_meta (key, value) VALUES ('order_ref_key_fingerprint', $1) ON CONFLICT (key) DO NOTHING`, [fp]);
  const { rows } = await db.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'order_ref_key_fingerprint'`);
  if (rows[0]?.value !== fp) {
    throw new Error('ORDER_REF_KEY has changed since order references were first issued. Restore the original key; never rotate it.');
  }
}

/**
 * Allocates a new permanent order reference. Call inside the transaction that creates the order, so a rolled-back
 * order does not keep its reference (the sequence number is simply skipped, never reused).
 * An existing order's old code (e.g. UT000123) can be passed as legacyRef to keep it as a permanent alias.
 */
export async function allocateOrderRef(db: Queryable, opts: { key: string; legacyRef?: string }): Promise<OrderRefRow> {
  let legacy: string | null = null;
  if (opts.legacyRef !== undefined) {
    legacy = normalizeLegacyRef(opts.legacyRef);
    if (!legacy) throw new Error(`"${opts.legacyRef}" is not a valid legacy order code`);
  }
  await assertKeyUnchanged(db, opts.key);
  const seq = await db.query<{ n: number }>(`SELECT nextval('order_ref_seq') AS n`);
  const ref = formatRef(Number(seq.rows[0]!.n), opts.key);
  const { rows } = await db.query<Row>(
    `INSERT INTO order_refs (ref, legacy_ref) VALUES ($1, $2) RETURNING ref, legacy_ref, allocated_at`,
    [ref, legacy]
  );
  return toRow(rows[0]!);
}

/** Finds an order reference from whatever was typed: the new format (any case/spacing) or an old UTnnnnnn code. */
export async function resolveOrderRef(db: Queryable, input: string): Promise<OrderRefRow | null> {
  const canonical = normalizeOrderRef(input);
  if (canonical) {
    const { rows } = await db.query<Row>(`SELECT ref, legacy_ref, allocated_at FROM order_refs WHERE ref = $1`, [canonical]);
    return rows[0] ? toRow(rows[0]) : null;
  }
  const legacy = normalizeLegacyRef(input);
  if (legacy) {
    const { rows } = await db.query<Row>(`SELECT ref, legacy_ref, allocated_at FROM order_refs WHERE legacy_ref = $1`, [legacy]);
    return rows[0] ? toRow(rows[0]) : null;
  }
  return null;
}
