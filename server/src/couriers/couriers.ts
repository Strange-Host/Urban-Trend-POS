import type { Pool } from '../db/pool.js';
import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';

export type CourierKind = 'rider' | 'organization';

export interface Courier {
  id: number;
  kind: CourierKind;
  name: string;
  phone: string | null;
  contactPerson: string | null;
  idNumber: string | null;
  vehiclePlate: string | null;
  agentNames: string[];
  collectsPayment: boolean;
  overdueLimitCents: number | null;
  overdueAfterDays: number;
  active: boolean;
  createdAt: Date;
}

interface Row {
  id: number; kind: CourierKind; name: string; phone: string | null; contact_person: string | null; id_number: string | null;
  vehicle_plate: string | null; agent_names: string[]; collects_payment: boolean; overdue_limit_cents: number | null;
  overdue_after_days: number; active: boolean; created_at: Date;
}
const COLS = `id, kind, name, phone, contact_person, id_number, vehicle_plate, agent_names, collects_payment, overdue_limit_cents, overdue_after_days, active, created_at`;
const toCourier = (r: Row): Courier => ({
  id: r.id, kind: r.kind, name: r.name, phone: r.phone, contactPerson: r.contact_person, idNumber: r.id_number, vehiclePlate: r.vehicle_plate,
  agentNames: r.agent_names, collectsPayment: r.collects_payment, overdueLimitCents: r.overdue_limit_cents, overdueAfterDays: r.overdue_after_days,
  active: r.active, createdAt: r.created_at,
});

function need(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new HttpError(422, 'COURIER_FIELD_REQUIRED', `${label} is required.`);
  return value.trim();
}

async function insert(pool: Pool, kind: CourierKind, f: {
  name: string; phone?: string; contactPerson?: string; idNumber?: string; vehiclePlate?: string; agentNames?: string[];
  collectsPayment?: boolean; overdueLimitCents?: number; overdueAfterDays?: number; actor: string;
}): Promise<Courier> {
  need(f.actor, 'The person adding the courier');
  try {
    const { rows } = await pool.query<Row>(
      `INSERT INTO couriers (kind, name, phone, contact_person, id_number, vehicle_plate, agent_names, collects_payment, overdue_limit_cents, overdue_after_days, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLS}`,
      [kind, need(f.name, 'A name'), f.phone?.trim() || null, f.contactPerson?.trim() || null, f.idNumber?.trim() || null, f.vehiclePlate?.trim() || null,
       (f.agentNames ?? []).map((a) => a.trim()).filter(Boolean), f.collectsPayment ?? false, f.overdueLimitCents ?? null, f.overdueAfterDays ?? 14, f.actor.trim()]);
    return toCourier(rows[0]!);
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'couriers_name_per_kind') {
      throw new HttpError(409, 'COURIER_EXISTS', `A ${kind} called "${f.name.trim()}" already exists.`);
    }
    throw err;
  }
}

/** Riders never collect money and never log in: staff record outcomes from the rider's report. */
export const addRider = (pool: Pool, f: { name: string; phone?: string; idNumber?: string; vehiclePlate?: string; actor: string }) =>
  insert(pool, 'rider', f);

export const addOrganization = (pool: Pool, f: {
  name: string; contactPerson?: string; phone?: string; agentNames?: string[];
  /** Whether this organization collects the customer's payment and remits it afterwards. */
  collectsPayment: boolean;
  /** An overdue balance above this pauses new collect-on-delivery parcels to the organization. */
  overdueLimitCents?: number;
  /** A collected amount unremitted for longer than this counts as overdue. */
  overdueAfterDays?: number;
  actor: string;
}) => insert(pool, 'organization', f);

/** Couriers are deactivated, never deleted, so past orders keep their courier. */
export async function setCourierActive(pool: Pool, input: { courierId: number; active: boolean }): Promise<Courier> {
  const { rows } = await pool.query<Row>(`UPDATE couriers SET active = $2 WHERE id = $1 RETURNING ${COLS}`, [input.courierId, input.active]);
  if (!rows[0]) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');
  return toCourier(rows[0]);
}

export async function getCourier(db: Queryable, id: number): Promise<Courier | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLS} FROM couriers WHERE id = $1`, [id]);
  return rows[0] ? toCourier(rows[0]) : null;
}

export async function listCouriers(db: Queryable, opts: { kind?: CourierKind; activeOnly?: boolean } = {}): Promise<Courier[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLS} FROM couriers WHERE ($1::text IS NULL OR kind = $1) AND (NOT $2::boolean OR active) ORDER BY lower(name)`,
    [opts.kind ?? null, opts.activeOnly ?? false]);
  return rows.map(toCourier);
}

/** What we owe this courier, from the ledger: package fees and approved costs earned and not yet paid. */
export async function courierPayableCents(db: Queryable, courierId: number): Promise<number> {
  const { rows } = await db.query<{ b: number }>(
    `SELECT COALESCE(-sum(l.amount_cents), 0)::bigint AS b
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.code = 'COURIER_PAYABLE' AND e.courier_id = $1`, [courierId]);
  return rows[0]!.b;
}

export interface CourierProfile {
  courier: Courier;
  /** We owe the courier this much (package fees and approved costs, unpaid). */
  owedCents: number;
  unpaidFeesCents: number;
  unpaidCostsCents: number;
  oldestUnpaidAt: Date | null;
  dispatchesInProgress: number;
  totalEarnedCents: number;
  /** Organizations that collect: what they hold and have not yet remitted. */
  heldByOrganizationCents: number;
}

export async function courierProfile(db: Queryable, courierId: number): Promise<CourierProfile> {
  const courier = await getCourier(db, courierId);
  if (!courier) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');
  const { rows } = await db.query<{ fees: number; costs: number; oldest: Date | null; progress: number; earned: number; held: number }>(
    `SELECT
       COALESCE((SELECT sum(f.amount_cents) FROM package_fees f WHERE f.courier_id = $1 AND f.amount_cents > 0
                   AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)), 0)::bigint AS fees,
       COALESCE((SELECT sum(c.amount_cents) FROM courier_costs c WHERE c.courier_id = $1 AND c.status = 'approved'
                   AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.courier_cost_id = c.id)), 0)::bigint AS costs,
       (SELECT min(t) FROM (
          SELECT f.recorded_at AS t FROM package_fees f WHERE f.courier_id = $1 AND f.amount_cents > 0 AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)
          UNION ALL
          SELECT c.decided_at FROM courier_costs c WHERE c.courier_id = $1 AND c.status = 'approved' AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.courier_cost_id = c.id)) u) AS oldest,
       (SELECT count(*) FROM package_fees f JOIN orders o ON o.id = f.order_id WHERE f.courier_id = $1 AND o.status = 'dispatched')::bigint AS progress,
       (COALESCE((SELECT sum(f.amount_cents) FROM package_fees f WHERE f.courier_id = $1), 0)
        + COALESCE((SELECT sum(c.amount_cents) FROM courier_costs c WHERE c.courier_id = $1 AND c.status = 'approved'), 0))::bigint AS earned,
       COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                  WHERE a.code = 'ORG_RECEIVABLE' AND e.courier_id = $1), 0)::bigint AS held`, [courierId]);
  const r = rows[0]!;
  return {
    courier, owedCents: r.fees + r.costs, unpaidFeesCents: r.fees, unpaidCostsCents: r.costs, oldestUnpaidAt: r.oldest,
    dispatchesInProgress: r.progress, totalEarnedCents: r.earned, heldByOrganizationCents: r.held,
  };
}
