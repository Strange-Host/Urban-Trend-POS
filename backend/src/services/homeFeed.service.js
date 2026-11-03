const db = require('../config/db');
const permissionsService = require('./permissions.service');
const modulesService = require('./modules.service');
const settingsService = require('./settings.service');
const courierOrganizations = require('./courierOrganizations.service');
const { dateOf, localDate } = require('../utils/storeTime');

// What the mobile home screen shows: "needs attention" (things waiting on a decision, routed to the people who can make
// it) and the "today" strip. Both are read-only and cheap enough to run on a phone's schedule, and both are cached for a
// short time per person so a few phones refreshing never turn into a few hundred queries.
//
// ROUTING IS BY PERMISSION, not by role: every source below is gated by the same permission that guards the matching
// action in the rest of the API (approvals.review to decide voids and refunds, expenses.approve for expenses, ...). So an
// admin who takes a right away from a manager, or grants one to a cashier, changes this list with no extra work - and a
// person never sees an item they could not act on. Nobody is shown their own request to approve.
//
// Money is always integer cents, named ...Cents. Times are ISO-8601 UTC. Nothing here ever includes cost or profit.

const TTL_MS = 45 * 1000;                 // inside the spec's 30-60 second window
const MAX_ITEMS = 50;                     // what one response carries; `total` says how many there really are
const PER_SOURCE = 25;
const SEVERITY_RANK = { urgent: 0, warning: 1, info: 2 };

const cache = new Map();                  // key -> { at, value }
function cached(key, build) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = build();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) for (const k of cache.keys()) { if (Date.now() - cache.get(k).at >= TTL_MS) cache.delete(k); }
  return value;
}
const clearCache = () => cache.clear();

// Database times are UTC text 'YYYY-MM-DD HH:MM:SS'; the app gets ISO.
const iso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'}`).toISOString() : null);
const kes = (cents) => `KES ${((Number(cents) || 0) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
const ageHours = (s) => (Date.now() - Date.parse(iso(s))) / 3_600_000;

// ---- the attention sources ---------------------------------------------------------------------------------------------
// Each: { kind, permission, enabled?(), load(user) -> { total, rows } }. `rows` become items; see `item()`.

function item({ kind, id, severity = 'warning', title, detail = null, amountCents = null, since, link = null }) {
  return { id: `${kind}:${id}`, kind, severity, title, detail, amountCents, since: iso(since), link };
}

const SOURCES = [
  {
    kind: 'approval_request', permission: 'approvals.review',
    load: (u) => {
      const where = `ar.store_id = ? AND ar.status = 'pending' AND ar.requested_by != ?`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests ar WHERE ${where}`).get(u.storeId, u.id).n;
      const rows = db.prepare(`
        SELECT ar.id, ar.kind, ar.sale_id, ar.payment_record_id, ar.amount, ar.reason, ar.requested_at, ru.name AS who
        FROM approval_requests ar JOIN users ru ON ru.id = ar.requested_by WHERE ${where} ORDER BY ar.id LIMIT ?`).all(u.storeId, u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'approval_request', id: r.id,
          title: `${r.who} asked to ${r.kind === 'void_sale' ? `void sale S-${r.sale_id}` : `refund payment #${r.payment_record_id}`}`,
          detail: r.reason, amountCents: r.amount, since: r.requested_at, link: { type: 'approval', id: r.id },
        })),
      };
    },
  },
  {
    kind: 'expense_pending', permission: 'expenses.approve',
    load: (u) => {
      const where = `e.store_id = ? AND e.status = 'pending' AND e.recorded_by_staff_id != ?`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM expenses e WHERE ${where}`).get(u.storeId, u.id).n;
      const rows = db.prepare(`
        SELECT e.id, e.amount, e.description, e.created_at, s.name AS who FROM expenses e JOIN users s ON s.id = e.recorded_by_staff_id
        WHERE ${where} ORDER BY e.id LIMIT ?`).all(u.storeId, u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'expense_pending', id: r.id, title: `${r.who} recorded an expense of ${kes(r.amount)}`, detail: r.description,
          amountCents: r.amount, since: r.created_at, link: { type: 'expense', id: r.id },
        })),
      };
    },
  },
  {
    kind: 'petty_cash_pending', permission: 'expenses.approve',
    load: (u) => {
      const where = `t.store_id = ? AND t.status = 'pending' AND t.recorded_by_staff_id != ?`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM petty_cash_topups t WHERE ${where}`).get(u.storeId, u.id).n;
      const rows = db.prepare(`
        SELECT t.id, t.amount, t.note, t.created_at, s.name AS who FROM petty_cash_topups t JOIN users s ON s.id = t.recorded_by_staff_id
        WHERE ${where} ORDER BY t.id LIMIT ?`).all(u.storeId, u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'petty_cash_pending', id: r.id, title: `${r.who} asked to top up petty cash by ${kes(r.amount)}`, detail: r.note,
          amountCents: r.amount, since: r.created_at, link: { type: 'petty_cash_topup', id: r.id },
        })),
      };
    },
  },
  {
    kind: 'requisition_pending', permission: 'requisitions.approve', enabled: () => modulesService.isEnabled('hr'),
    load: (u) => {
      const where = `r.status = 'pending' AND (r.store_id = ? OR r.store_id IS NULL) AND r.requested_by_staff_id != ?`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM requisitions r WHERE ${where}`).get(u.storeId, u.id).n;
      const rows = db.prepare(`
        SELECT r.id, r.type, r.amount, r.notes, r.created_at, s.name AS who FROM requisitions r JOIN users s ON s.id = r.requested_by_staff_id
        WHERE ${where} ORDER BY r.id LIMIT ?`).all(u.storeId, u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'requisition_pending', id: r.id,
          title: r.type === 'salary_advance' ? `${r.who} asked for a salary advance of ${kes(r.amount)}` : `${r.who} sent a shop requisition`,
          detail: r.notes, amountCents: r.type === 'salary_advance' ? r.amount : null, since: r.created_at, link: { type: 'requisition', id: r.id },
        })),
      };
    },
  },
  {
    kind: 'product_pending', permission: 'products.approve',
    load: (u) => {
      const where = `p.approval_status = 'pending' AND (p.submitted_by_staff_id IS NULL OR p.submitted_by_staff_id != ?)`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`).get(u.id).n;
      const rows = db.prepare(`
        SELECT p.id, p.name, p.created_at, s.name AS who FROM products p LEFT JOIN users s ON s.id = p.submitted_by_staff_id
        WHERE ${where} ORDER BY p.id LIMIT ?`).all(u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'product_pending', id: r.id, severity: 'info', title: `${r.who || 'Someone'} proposed a new product: ${r.name}`,
          since: r.created_at, link: { type: 'product', id: r.id },
        })),
      };
    },
  },
  {
    kind: 'stock_transfer_pending', permission: 'stock.review',
    load: (u) => {
      const where = `t.status = 'pending' AND (t.from_store_id = ? OR t.to_store_id = ?) AND t.requested_by_staff_id != ?`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM stock_transfers t WHERE ${where}`).get(u.storeId, u.storeId, u.id).n;
      const rows = db.prepare(`
        SELECT t.id, t.note, t.created_at, s.name AS who, fs.name AS from_store, ts.name AS to_store
        FROM stock_transfers t JOIN users s ON s.id = t.requested_by_staff_id
        JOIN stores fs ON fs.id = t.from_store_id JOIN stores ts ON ts.id = t.to_store_id
        WHERE ${where} ORDER BY t.id LIMIT ?`).all(u.storeId, u.storeId, u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'stock_transfer_pending', id: r.id, title: `${r.who} asked to move stock from ${r.from_store} to ${r.to_store}`,
          detail: r.note, since: r.created_at, link: { type: 'stock_transfer', id: r.id },
        })),
      };
    },
  },
  {
    kind: 'stock_count_pending', permission: 'stock.review',
    load: (u) => {
      const where = `c.store_id = ? AND c.status = 'submitted' AND c.submitted_by_staff_id != ?`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM stock_counts c WHERE ${where}`).get(u.storeId, u.id).n;
      const rows = db.prepare(`
        SELECT c.id, c.kind, c.count_date, c.submitted_at, s.name AS who FROM stock_counts c JOIN users s ON s.id = c.submitted_by_staff_id
        WHERE ${where} ORDER BY c.id LIMIT ?`).all(u.storeId, u.id, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'stock_count_pending', id: r.id, title: `${r.who} submitted the ${r.kind} stock count for ${r.count_date}`,
          since: r.submitted_at, link: { type: 'stock_count', id: r.id },
        })),
      };
    },
  },
  {
    // Spec trigger: "unmatched payment older than 1 hour". Younger ones are usually just waiting for the order to be keyed in.
    kind: 'unmatched_payment', permission: 'payments.reconcile',
    load: (u) => {
      const where = `n.store_id = ? AND n.direction = 'incoming' AND n.status = 'unmatched' AND n.created_at <= datetime('now', '-1 hour')`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM payment_notifications n WHERE ${where}`).get(u.storeId).n;
      const rows = db.prepare(`
        SELECT n.id, n.source, n.amount, n.payer_name, n.external_reference, n.created_at FROM payment_notifications n
        WHERE ${where} ORDER BY n.id LIMIT ?`).all(u.storeId, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'unmatched_payment', id: r.id, severity: ageHours(r.created_at) >= 24 ? 'urgent' : 'warning',
          title: `${kes(r.amount)} ${String(r.source).toUpperCase()} payment matched no order`,
          detail: [r.payer_name && `From ${r.payer_name}`, r.external_reference].filter(Boolean).join(' · ') || null,
          amountCents: r.amount, since: r.created_at, link: { type: 'unmatched_payment', id: r.id },
        })),
      };
    },
  },
  {
    // Spec trigger: "courier remittance overdue". A courier organization holding customer money past its overdue limit.
    kind: 'courier_remittance_overdue', permission: 'couriers.settle',
    load: (u) => {
      const orgs = db.prepare(`SELECT id, name FROM couriers WHERE store_id = ? AND kind = 'organization' AND collects_payment = 1 ORDER BY name`).all(u.storeId);
      const rows = [];
      for (const o of orgs) {
        const standing = courierOrganizations.organizationStanding({ storeId: u.storeId, courierId: o.id });
        if (standing.overdue <= 0) continue;
        const oldest = db.prepare('SELECT MIN(collected_on) AS d FROM org_collections WHERE courier_id = ?').get(o.id).d;
        rows.push(item({
          kind: 'courier_remittance_overdue', id: o.id, severity: standing.paused ? 'urgent' : 'warning',
          title: `${o.name} owes ${kes(standing.overdue)} past its due date`,
          detail: standing.paused ? 'Paused for new collect-on-delivery parcels.' : null,
          amountCents: standing.overdue, since: oldest ? `${oldest} 00:00:00` : null, link: { type: 'courier', id: o.id },
        }));
      }
      return { total: rows.length, items: rows.slice(0, PER_SOURCE) };
    },
  },
  {
    // Spec trigger: "cash variance above threshold". Recently closed tills whose count missed what they should hold.
    // There is no "reviewed" flag on a till yet, so an item drops off after three days rather than when someone acts on it.
    kind: 'cash_variance', permission: 'cashsessions.view',
    load: (u) => {
      const threshold = Math.round(Number(settingsService.getAll().attention_cash_variance_kes) * 100);
      const where = `s.store_id = ? AND s.closed_at IS NOT NULL AND s.closing_amount IS NOT NULL AND s.expected_amount IS NOT NULL
        AND ABS(s.closing_amount - s.expected_amount) >= ? AND s.closed_at >= datetime('now', '-3 days')`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM cash_sessions s WHERE ${where}`).get(u.storeId, Math.max(threshold, 1)).n;
      const rows = db.prepare(`
        SELECT s.id, s.closing_amount - s.expected_amount AS diff, s.closed_at, c.name AS who
        FROM cash_sessions s JOIN users c ON c.id = s.user_id WHERE ${where} ORDER BY s.id DESC LIMIT ?`).all(u.storeId, Math.max(threshold, 1), PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({
          kind: 'cash_variance', id: r.id, title: `${r.who}'s till was ${r.diff < 0 ? 'short' : 'over'} by ${kes(Math.abs(r.diff))}`,
          amountCents: Math.abs(r.diff), since: r.closed_at, link: { type: 'cash_session', id: r.id },
        })),
      };
    },
  },
  {
    // Spec trigger: "large stock adjustment". The existing security alert already decides what counts as large
    // (security_alert_stock_units), so this lists those alerts from the last two days instead of re-deriving the rule.
    kind: 'stock_adjusted', permission: 'stock.review',
    load: (u) => {
      const where = `e.type = 'stock_adjusted' AND (e.store_id = ? OR e.store_id IS NULL) AND e.created_at >= datetime('now', '-2 days')`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM security_events e WHERE ${where}`).get(u.storeId).n;
      const rows = db.prepare(`SELECT e.id, e.severity, e.title, e.detail, e.created_at FROM security_events e WHERE ${where} ORDER BY e.id DESC LIMIT ?`).all(u.storeId, PER_SOURCE);
      return {
        total,
        items: rows.map((r) => item({ kind: 'stock_adjusted', id: r.id, severity: r.severity, title: r.title, detail: r.detail, since: r.created_at, link: { type: 'security_event', id: r.id } })),
      };
    },
  },
];

/** The people-facing list: everything waiting on this person, most urgent first, oldest first within a level. */
function attention(user) {
  return cached(`attention:${user.id}`, () => {
    const items = [];
    const counts = {};
    let total = 0;
    for (const source of SOURCES) {
      if (!permissionsService.can(user, source.permission)) continue;
      if (source.enabled && !source.enabled()) continue;
      const { total: n, items: rows } = source.load(user);
      if (!n) continue;
      counts[source.kind] = n;
      total += n;
      items.push(...rows);
    }
    const when = (i) => (i.since ? Date.parse(i.since) : 0);
    items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || when(a) - when(b));
    return { generatedAt: new Date().toISOString(), total, counts, items: items.slice(0, MAX_ITEMS) };
  });
}

// ---- the "today" strip ---------------------------------------------------------------------------------------------------

/**
 * Today at the shop. Someone who may see reports (reports.view) gets the whole shop's figures; everyone else gets only
 * their own till: how many sales they rang up today and for how much. Neither ever includes cost or profit.
 */
function summary(user) {
  return cached(`summary:${user.id}`, () => {
    const date = localDate(0);
    const base = { generatedAt: new Date().toISOString(), date, currency: settingsService.getAll().business_currency || 'KES' };

    if (!permissionsService.can(user, 'reports.view')) {
      const mine = db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM sales
        WHERE store_id = ? AND cashier_id = ? AND status = 'completed' AND ${dateOf('created_at')} = ?`).get(user.storeId, user.id, date);
      return { ...base, scope: 'mine', mySalesCount: mine.n, mySalesCents: mine.total };
    }

    const pos = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM sales
      WHERE store_id = ? AND status = 'completed' AND ${dateOf('created_at')} = ?`).get(user.storeId, date);
    // Same definition of "sold" as the web dashboard: online orders count once the money is actually in.
    const online = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(amount_paid), 0) AS total FROM orders
      WHERE store_id = ? AND status IN ('dispatched_paid','dispatched_partial') AND ${dateOf('dispatched_at')} = ?
        AND deleted_at IS NULL AND sale_id IS NULL`).get(user.storeId, date);
    const posCash = db.prepare(`
      SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.store_id = ? AND ${dateOf('p.created_at')} = ?`).get(user.storeId, date).total;
    const orderCash = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records
      WHERE store_id = ? AND direction = 'incoming' AND status = 'completed' AND order_id IS NOT NULL AND ${dateOf('created_at')} = ?
        AND order_id NOT IN (SELECT id FROM orders WHERE sale_id IS NOT NULL)`).get(user.storeId, date).total;
    const lowStock = db.prepare(`
      SELECT COUNT(*) AS c FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.store_id = ? AND i.quantity <= i.reorder_level AND p.is_active = 1`).get(user.storeId).c;

    return {
      ...base, scope: 'shop',
      posSalesCents: pos.total, posSalesCount: pos.n,
      onlineSalesCents: online.total, onlineOrderCount: online.n,
      totalSalesCents: pos.total + online.total,
      cashCollectedCents: posCash + orderCash,
      lowStockCount: lowStock,
      attentionCount: attention(user).total,
    };
  });
}

module.exports = { attention, summary, clearCache, TTL_MS };
