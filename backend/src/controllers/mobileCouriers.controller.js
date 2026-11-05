const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1 } = require('../utils/mobileAudit');
const orgs = require('../services/courierOrganizations.service');

// What courier organizations owe the shop, and recording the money they hand over (couriers.settle). The maths is the
// website's: createStatement nets off the fees we owe them, keeps the expected/received/variance, and cannot be undone.

const toIso = (s) => (s && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);

const balances = asyncHandler(async (req, res) => {
  const couriers = db.prepare(`SELECT id, name, kind FROM couriers WHERE store_id = ? AND kind = 'organization' AND collects_payment = 1 AND is_active = 1`).all(req.user.storeId);
  const items = couriers.map((c) => {
    const st = orgs.organizationStanding({ storeId: req.user.storeId, courierId: c.id });
    const open = db.prepare(`
      SELECT COUNT(*) AS n, MIN(k.collected_on) AS oldest FROM org_collections k
       WHERE k.courier_id = ? AND NOT EXISTS (SELECT 1 FROM org_statement_lines l WHERE l.collection_id = k.id)
    `).get(c.id);
    return {
      courierId: c.id, name: c.name, kind: c.kind, outstandingCents: st.outstanding, overdueCents: st.overdue, paused: st.paused,
      openCollections: open.n, oldestCollectionOn: open.oldest || null, buckets: st.buckets,
    };
  }).sort((a, b) => b.outstandingCents - a.outstandingCents || a.name.localeCompare(b.name));
  res.json({ items });
});

const collections = asyncHandler(async (req, res) => {
  const rows = orgs.listOpenCollections({ storeId: req.user.storeId, courierId: Number(req.params.id) });
  const names = db.prepare('SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id IN (' + (rows.map(() => '?').join(',') || 'NULL') + ')').all(...rows.map((r) => r.order_id));
  const nameOf = Object.fromEntries(names.map((n) => [n.id, n.name]));
  // The package fee we owe for each parcel and have not netted off yet: what the statement will deduct from the cash.
  const feeRows = rows.length ? db.prepare(`
    SELECT f.order_id, SUM(f.amount) AS fee FROM package_fees f
     WHERE f.courier_id = ? AND f.amount > 0 AND f.order_id IN (${rows.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id) GROUP BY f.order_id
  `).all(Number(req.params.id), ...rows.map((r) => r.order_id)) : [];
  const feeOf = Object.fromEntries(feeRows.map((f) => [f.order_id, f.fee]));
  res.json({ items: rows.map((k) => ({
    collectionId: k.id, orderId: k.order_id, orderNumber: k.product_code || `#${k.order_id}`, customerName: nameOf[k.order_id] || '', amountCents: k.amount, feeCents: feeOf[k.order_id] || 0, collectedOn: k.collected_on,
  })) });
});

const remittances = asyncHandler(async (req, res) => {
  const courierId = Number(req.params.id);
  const limit = cursorUtil.pageSize(req.query.limit);
  const cur = cursorUtil.decode(req.query.cursor);
  orgs.listStatements({ storeId: req.user.storeId, courierId }); // 404s for an unknown organization
  const rows = db.prepare(`
    SELECT s.*, u.name AS created_by_name FROM org_statements s LEFT JOIN users u ON u.id = s.created_by
    WHERE s.store_id = @storeId AND s.courier_id = @courierId ${cur && Number.isInteger(cur.i) ? 'AND s.id < @before' : ''}
    ORDER BY s.id DESC LIMIT @take
  `).all({ storeId: req.user.storeId, courierId, before: cur && cur.i, take: limit + 1 });
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  res.json({
    items: page.map((s) => ({
      id: s.id, createdAt: toIso(s.created_at), createdBy: { id: s.created_by, name: s.created_by_name || 'Unknown' },
      collectionsCents: s.collections, feesCents: s.fees, remittedCents: s.remitted, cashVarianceCents: s.cash_variance, reference: s.remittance_ref || null,
    })),
    nextCursor: more ? cursorUtil.encode({ i: page[page.length - 1].id }) : null,
  });
});

const createRemittance = asyncHandler(async (req, res) => {
  const courierId = Number(req.params.id);
  const { collectionIds, remittedCents, reference, note } = req.body;
  const found = db.prepare(`SELECT MIN(collected_on) AS a, MAX(collected_on) AS b FROM org_collections WHERE courier_id = ? AND id IN (${collectionIds.map(() => '?').join(',')})`).get(courierId, ...collectionIds);
  const today = new Date().toISOString().slice(0, 10);
  const feesOwed = orgs.feesOwedOn({ courierId, collectionIds });
  let row;
  try {
    row = orgs.createStatement({
      storeId: req.user.storeId, staffId: req.user.id, courierId,
      periodStart: found.a || today, periodEnd: found.b || today,
      collectionIds, remitted: remittedCents,
      // The organization's own charge is not on the phone's form: it defaults to what our records say we owe, so a
      // phone remittance never invents a charge variance. (The website still records one when staff type it.)
      chargeEntered: req.body.chargeEnteredCents ?? feesOwed,
      remittanceRef: reference,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'STATEMENT_PARCEL_ALREADY_LISTED') {
      throw new ApiError(409, 'One of those parcels was already settled on another remittance.', null, 'ALREADY_SETTLED');
    }
    throw e;
  }
  // Statements have no notes column, so the note and the phone go into the audit trail.
  auditV1(req, { action: 'update', entityType: 'org_statement_note', entityId: row.id, after: { remitted: row.remitted, parcels: collectionIds.length }, reason: note || null });
  res.status(201).json({ id: row.id, remittedCents: row.remitted, expectedCents: row.collections - row.fees, cashVarianceCents: row.cash_variance, settledCount: collectionIds.length });
});

module.exports = { balances, collections, remittances, createRemittance };
