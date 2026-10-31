const db = require('../config/db');

// Stock costing: batches, FIFO / average valuation, and the cost of what was sold.
//
// WHY THIS REPLAYS THE LEDGER INSTEAD OF KEEPING ITS OWN LAYER TABLE
// Stock changes in about ten places (till sales, online dispatch, receiving, issues, transfers, counts, requisitions,
// the Shopify/WooCommerce syncs, reconciliation). Every one of them already writes inventory_movements, and that table is
// the audit trail the reconciliation job trusts. A second, mutable "remaining quantity per batch" table would have to be
// kept in step by all ten, and would drift the first time one of them was missed. So the layers are DERIVED: replaying a
// product's movements in order rebuilds, per store, what is on the shelf, which received batch each unit came from, and
// what it cost. Nothing here can disagree with the ledger because it is computed from it.
//
// THE RULES THE REPLAY APPLIES
//  - A batch is a receipt line (stock_receipt_items). Its cost is the line's unit_cost; until someone who may see buying
//    prices fills that in, the units are valued at the product's current cost_price.
//  - Stock leaves oldest batch first, unless a movement names a batch (a recall, or writing off a named batch).
//  - A transfer carries the batches (and so the cost and expiry) from the sending store to the receiving one.
//  - A void or an inspected-good return puts back the very units, at the cost, they left with.
//  - Any other increase (a count, an adjustment, a sync) comes in at the latest known buying price.
//  - Stock that predates all of this (no receipt line) is valued at the product's cost_price, which is what the old
//    "quantity x cost_price" figure did, so existing numbers do not move until a batch is costed.
// Method: 'fifo' values what is left from the batches it came from. 'average' uses a moving average per store. The
// setting only chooses which figure is reported and which cost is recorded on a new sale; history already recorded on
// sale_items/order_items.cost_total is never rewritten.

const METHODS = ['fifo', 'average'];

function getMethod() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'inventory_valuation_method'`).get();
  return row && METHODS.includes(row.value) ? row.value : 'fifo';
}

function newState() {
  return { layers: [], qty: 0, value: 0 };
}

function addLayer(state, layer) {
  if (layer.qty <= 0) return;
  state.layers.push({ batchId: layer.batchId ?? null, qty: layer.qty, cost: layer.cost, costed: layer.costed !== false });
  state.qty += layer.qty;
  state.value += layer.cost;
}

// Takes `q` units out of a store. Returns the pieces that left (batch, quantity, cost) and their total cost.
function consume(state, q, batchId, ctx) {
  const take = Math.min(q, state.qty);
  const pieces = [];
  let need = take;

  const pull = (onlyBatch) => {
    for (let i = 0; i < state.layers.length && need > 0;) {
      const layer = state.layers[i];
      if (onlyBatch !== null && layer.batchId !== onlyBatch) { i += 1; continue; }
      const t = Math.min(layer.qty, need);
      const c = t === layer.qty ? layer.cost : Math.round((layer.cost * t) / layer.qty);
      pieces.push({ batchId: layer.batchId, qty: t, cost: c, costed: layer.costed });
      layer.qty -= t; layer.cost -= c; need -= t;
      if (layer.qty === 0) state.layers.splice(i, 1); else i += 1;
    }
  };
  if (batchId != null) pull(batchId); // the named batch first...
  pull(null);                         // ...then oldest first (also covers a named batch that ran short)

  let cost = pieces.reduce((n, p) => n + p.cost, 0);
  if (ctx.method === 'average' && take > 0) {
    // Moving average: every unit leaving costs the store's current average, whichever batch it came from.
    const before = state.value;
    const beforeQty = state.qty;
    cost = take === beforeQty ? before : Math.round((before * take) / beforeQty);
    let left = cost;
    pieces.forEach((p, i) => {
      p.cost = i === pieces.length - 1 ? left : Math.round((cost * p.qty) / take);
      left -= p.cost;
    });
  }
  state.qty -= take;
  state.value -= cost;
  if (state.qty === 0) { state.value = 0; state.layers.length = 0; }

  const short = q - take; // the ledger says more left than we can account for (very old data): cost it at the latest known price
  if (short > 0) {
    const c = short * ctx.fallbackUnit;
    pieces.push({ batchId: null, qty: short, cost: c, costed: true });
    cost += c;
  }
  return { cost, pieces };
}

function takeFromStash(stash, q) {
  const out = [];
  let need = q;
  while (stash && stash.length && need > 0) {
    const p = stash[0];
    const t = Math.min(p.qty, need);
    const c = t === p.qty ? p.cost : Math.round((p.cost * t) / p.qty);
    out.push({ batchId: p.batchId, qty: t, cost: c, costed: p.costed });
    p.qty -= t; p.cost -= c; need -= t;
    if (p.qty === 0) stash.shift();
  }
  return { pieces: out, left: need };
}

const STASH_OUT = { transfer_out: 't', sale: 's', dispatch: 'o' };
const STASH_IN = { transfer_in: 't', void: 's', return_resellable: 'o' };

// Prepared on use, not at require time: this file is loaded before a fresh database has been migrated.
const selectProduct = { get: (id) => db.prepare('SELECT id, cost_price FROM products WHERE id = ?').get(id) };
const selectMovements = { all: (id) => db.prepare(`
  SELECT id, store_id, change_qty, reason, reference_id, batch_id FROM inventory_movements WHERE product_id = ? ORDER BY id
`).all(id) };
const selectItems = { all: (id) => db.prepare(`
  SELECT id, receipt_id, quantity, unit_cost FROM stock_receipt_items WHERE product_id = ? ORDER BY id
`).all(id) };

// Replays one product. Returns { stores: Map(storeId -> state), events: Map(movementId -> {cost, pieces}) }.
function replay(productId, method = getMethod()) {
  const product = selectProduct.get(productId);
  const catalogCost = product ? product.cost_price : 0;
  const ctx = { method, fallbackUnit: catalogCost };
  const stores = new Map();
  const events = new Map();
  const stashes = new Map();

  const itemsByReceipt = new Map();
  for (const it of selectItems.all(productId)) {
    if (!itemsByReceipt.has(it.receipt_id)) itemsByReceipt.set(it.receipt_id, []);
    itemsByReceipt.get(it.receipt_id).push(it);
  }

  for (const m of selectMovements.all(productId)) {
    if (!stores.has(m.store_id)) stores.set(m.store_id, newState());
    const state = stores.get(m.store_id);

    if (m.change_qty < 0) {
      const res = consume(state, -m.change_qty, m.batch_id, ctx);
      events.set(m.id, res);
      const kind = STASH_OUT[m.reason];
      if (kind) {
        const key = `${kind}:${m.reference_id}`;
        if (!stashes.has(key)) stashes.set(key, []);
        stashes.get(key).push(...res.pieces.map((p) => ({ ...p })));
      }
      continue;
    }

    let remaining = m.change_qty;
    if (m.reason === 'receipt') {
      const queue = itemsByReceipt.get(m.reference_id) || [];
      const at = queue.findIndex((it) => it.quantity === m.change_qty);
      const item = queue.splice(at >= 0 ? at : 0, 1)[0];
      if (item) {
        const costed = item.unit_cost !== null && item.unit_cost !== undefined;
        const unit = costed ? item.unit_cost : catalogCost;
        addLayer(state, { batchId: item.id, qty: m.change_qty, cost: m.change_qty * unit, costed });
        if (costed) ctx.fallbackUnit = item.unit_cost;
        remaining = 0;
      }
    } else if (STASH_IN[m.reason]) {
      const got = takeFromStash(stashes.get(`${STASH_IN[m.reason]}:${m.reference_id}`), remaining);
      for (const p of got.pieces) addLayer(state, p);
      remaining = got.left;
    }
    if (remaining > 0) addLayer(state, { batchId: null, qty: remaining, cost: remaining * ctx.fallbackUnit, costed: true });
  }
  return { stores, events, method };
}

// What the next `qty` units leaving `storeId` cost right now (recorded on the sale line / order line when it is made).
function costOfNextUnits(productId, storeId, qty, { batchId = null } = {}) {
  const run = replay(productId);
  const state = run.stores.get(storeId) || newState();
  const product = selectProduct.get(productId);
  return consume(state, qty, batchId, { method: run.method, fallbackUnit: product ? product.cost_price : 0 });
}

// How many units of one batch are on the shelf of one store right now.
function batchRemaining(productId, storeId, batchId) {
  const state = replay(productId).stores.get(storeId);
  if (!state) return 0;
  return state.layers.filter((l) => l.batchId === batchId).reduce((n, l) => n + l.qty, 0);
}

// What each stock issue cost us (its movement's cost under the current method). Input: [{ id, product_id }].
function costOfIssues(issues) {
  const out = new Map();
  const byProduct = new Map();
  for (const i of issues) {
    if (!byProduct.has(i.product_id)) byProduct.set(i.product_id, []);
    byProduct.get(i.product_id).push(i.id);
  }
  for (const [productId, issueIds] of byProduct) {
    const run = replay(productId);
    const moves = db.prepare(`
      SELECT id, reference_id FROM inventory_movements
      WHERE product_id = ? AND reference_type = 'issue' AND reference_id IN (${issueIds.map(() => '?').join(',')})
    `).all(productId, ...issueIds);
    for (const m of moves) out.set(m.reference_id, run.events.has(m.id) ? run.events.get(m.id).cost : 0);
  }
  return out;
}

// ---------------------------------------------------------------- valuation

const cache = new Map();

function signature(method) {
  const m = db.prepare('SELECT COALESCE(MAX(id), 0) AS a FROM inventory_movements').get().a;
  const r = db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS a, COUNT(unit_cost) AS b, COALESCE(SUM(unit_cost), 0) AS c, COUNT(recalled_at) AS d FROM stock_receipt_items
  `).get();
  const p = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS u, COALESCE(SUM(cost_price), 0) AS c FROM products`).get();
  return [method, m, r.a, r.b, r.c, r.d, p.n, p.u, p.c].join('|');
}

// Value of what is on hand, per product and store, under one method. Cached until the ledger, a batch cost or a product changes.
function valuationRows({ storeId = null, method = getMethod() } = {}) {
  const key = `${storeId ?? 'all'}:${method}`;
  const sig = signature(method);
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.rows;

  const products = db.prepare(`
    SELECT DISTINCT p.id, p.sku, p.name, p.sell_price, p.cost_price, p.is_active
    FROM products p JOIN inventory i ON i.product_id = p.id
    WHERE p.approval_status = 'approved' ${storeId ? 'AND i.store_id = ?' : ''}
    ORDER BY p.name
  `).all(...(storeId ? [storeId] : []));

  const rows = [];
  for (const p of products) {
    const run = replay(p.id, method);
    for (const [sid, state] of run.stores) {
      if (storeId && sid !== storeId) continue;
      if (state.qty <= 0) continue;
      rows.push({
        product_id: p.id, sku: p.sku, name: p.name, store_id: sid, is_active: p.is_active,
        quantity: state.qty,
        cost_value: state.value,
        unit_cost: Math.round(state.value / state.qty),
        retail_value: state.qty * p.sell_price,
        uncosted_units: state.layers.filter((l) => !l.costed).reduce((n, l) => n + l.qty, 0),
      });
    }
  }
  cache.set(key, { sig, rows });
  return rows;
}

function valuationTotals({ storeId = null, method = getMethod(), activeOnly = true } = {}) {
  const rows = valuationRows({ storeId, method }).filter((r) => !activeOnly || r.is_active === 1);
  return rows.reduce((t, r) => ({
    total_cost_value: t.total_cost_value + r.cost_value,
    total_retail_value: t.total_retail_value + r.retail_value,
    total_units: t.total_units + r.quantity,
    uncosted_units: t.uncosted_units + r.uncosted_units,
  }), { total_cost_value: 0, total_retail_value: 0, total_units: 0, uncosted_units: 0 });
}

// ---------------------------------------------------------------- batches (expiry and recall)

// One row per (batch, store) that still holds units, or per recalled batch. The remaining count is exact where stock left
// oldest-first (the normal case) and exact by name where a movement named the batch.
function batchRows({ storeId = null } = {}) {
  const items = db.prepare(`
    SELECT i.id AS batch_id, i.product_id, i.batch_no, i.expiry_date, i.quantity AS received_qty,
           i.recalled_at, i.recall_note, r.received_on, r.store_id AS received_store_id, s.name AS supplier_name,
           p.name AS product_name, p.sku
    FROM stock_receipt_items i
    JOIN stock_receipts r ON r.id = i.receipt_id
    JOIN products p ON p.id = i.product_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE i.expiry_date IS NOT NULL OR i.recalled_at IS NOT NULL
  `).all();
  if (items.length === 0) return [];

  const quarantined = new Map(db.prepare(`
    SELECT batch_id, SUM(quantity) AS q FROM stock_issues WHERE reason = 'recalled' AND batch_id IS NOT NULL GROUP BY batch_id
  `).all().map((r) => [r.batch_id, r.q]));

  const byProduct = new Map();
  for (const it of items) {
    if (!byProduct.has(it.product_id)) byProduct.set(it.product_id, []);
    byProduct.get(it.product_id).push(it);
  }

  const storeNames = new Map(db.prepare('SELECT id, name FROM stores').all().map((s) => [s.id, s.name]));
  const out = [];
  for (const [productId, list] of byProduct) {
    const run = replay(productId);
    for (const it of list) {
      const held = [];
      for (const [sid, state] of run.stores) {
        const qty = state.layers.filter((l) => l.batchId === it.batch_id).reduce((n, l) => n + l.qty, 0);
        if (qty > 0) held.push({ store_id: sid, qty });
      }
      const remainingTotal = held.reduce((n, h) => n + h.qty, 0);
      const base = {
        ...it,
        quarantined_qty: quarantined.get(it.batch_id) || 0,
        remaining_total: remainingTotal,
      };
      base.units_gone = it.received_qty - remainingTotal - base.quarantined_qty;
      if (it.recalled_at && held.length === 0) {
        if (!storeId || it.received_store_id === storeId) out.push({ ...base, store_id: it.received_store_id, store_name: storeNames.get(it.received_store_id), remaining: 0 });
        continue;
      }
      for (const h of held) {
        if (storeId && h.store_id !== storeId) continue;
        out.push({ ...base, store_id: h.store_id, store_name: storeNames.get(h.store_id), remaining: h.qty });
      }
    }
  }
  return out;
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

// status: 'expired' | 'expiring' | 'recalled' | 'all'. `today` is the shop calendar date, passed in by the caller.
function batchesByStatus({ storeId = null, status = 'all', today, withinDays = 30 }) {
  const rows = batchRows({ storeId }).map((r) => {
    const days = r.expiry_date ? daysBetween(today, r.expiry_date) : null;
    let state = 'ok';
    if (r.recalled_at) state = 'recalled';
    else if (r.remaining > 0 && days !== null && days < 0) state = 'expired';
    else if (r.remaining > 0 && days !== null && days <= withinDays) state = 'expiring';
    return { ...r, days_left: days, state };
  });
  const keep = status === 'all' ? rows.filter((r) => r.remaining > 0 || r.state === 'recalled') : rows.filter((r) => r.state === status);
  return keep.sort((a, b) => (a.expiry_date || '9999').localeCompare(b.expiry_date || '9999') || a.batch_id - b.batch_id);
}

module.exports = {
  METHODS, getMethod, replay, costOfNextUnits, batchRemaining, costOfIssues,
  valuationRows, valuationTotals, batchRows, batchesByStatus,
};
