const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1, deviceIdOf } = require('../utils/mobileAudit');
const bulk = require('../services/bulkPricing.service');

// Bulk price change (permission prices.bulk, set on the routes). Preview never writes anything.

const preview = asyncHandler(async (req, res) => {
  res.json(bulk.plan(req.body));
});

const apply = asyncHandler(async (req, res) => {
  const out = bulk.apply(req.body, { userId: req.user.id, deviceId: deviceIdOf(req), reason: req.body.reason });
  auditV1(req, {
    action: 'create', entityType: 'price_batch', entityId: out.batchId, reason: req.body.reason,
    after: { category_id: req.body.categoryId, mode: req.body.mode, value: req.body.value, products: out.count },
  });
  res.status(201).json(out);
});

const batches = asyncHandler(async (req, res) => {
  const cur = cursorUtil.decode(req.query.cursor);
  const { rows, more } = bulk.listBatches({ beforeId: cur && Number.isInteger(cur.i) ? cur.i : null, limit: cursorUtil.pageSize(req.query.limit) });
  res.json({
    items: rows.map((b) => ({
      id: b.id, kind: b.kind, categoryId: b.category_id, categoryName: b.category_name, mode: b.mode, value: b.value, reason: b.reason,
      productCount: b.product_count, createdBy: { id: b.created_by, name: b.created_by_name || 'Unknown' }, createdAt: b.created_at,
      revertedAt: b.reverted_at || null, revertsBatchId: b.reverts_batch_id || null,
    })),
    nextCursor: more ? cursorUtil.encode({ i: rows[rows.length - 1].id }) : null,
  });
});

const revert = asyncHandler(async (req, res) => {
  const batchId = Number(req.params.batchId);
  const out = bulk.revert(batchId, { userId: req.user.id, deviceId: deviceIdOf(req), reason: (req.body.reason || '').trim() || null });
  auditV1(req, { action: 'create', entityType: 'price_batch', entityId: out.batchId, reason: (req.body.reason || '').trim() || `Reverted price change #${batchId}`,
    after: { reverts_batch_id: batchId, products: out.count, skipped: out.skipped.length } });
  res.status(201).json(out);
});

module.exports = { preview, apply, batches, revert };
