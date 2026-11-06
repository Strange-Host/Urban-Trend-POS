const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1 } = require('../utils/mobileAudit');
const leads = require('../services/leads.service');

// CRM leads for the phone. The website's rules are reused untouched (status machine, duplicate checks, conversion in one
// transaction); a cashier (the telesales agent) only ever sees leads assigned to them, and someone else's lead is a plain 404.

const iso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'}`).toISOString() : null);

const shape = (l) => ({
  id: l.id, name: l.name, phone: l.phone, email: l.email || null, source: l.source, status: l.status,
  followUpDate: l.follow_up_date || null, notes: l.notes || null, assignedTo: l.assigned_staff_id ? { id: l.assigned_staff_id, name: l.assigned_staff_name || '' } : null,
  interestedProduct: l.interested_product_id ? { id: l.interested_product_id, name: l.interested_product_name || null } : null,
  convertedOrderId: l.converted_order_id || null, lastActivityAt: iso(l.last_activity_at), createdAt: iso(l.created_at),
});

const scope = (req) => ({ storeId: req.user.storeId, role: req.user.role, userId: req.user.id });

function mustSee(req) {
  const l = leads.getById({ id: Number(req.params.id), ...scope(req) });
  if (!l) throw new ApiError(404, 'Lead not found.');
  return l;
}

const detailOf = (l) => ({
  ...shape(l),
  activities: (l.activities || []).map((a) => ({ id: a.id, type: a.type, content: a.content || null, by: a.staff_name || null, at: iso(a.created_at) })),
});

const list = asyncHandler(async (req, res) => {
  const limit = cursorUtil.pageSize(req.query.limit);
  const cur = cursorUtil.decode(req.query.cursor);
  const offset = cur && Number.isInteger(cur.o) && cur.o > 0 ? cur.o : 0;
  const { rows, total } = leads.list({ ...scope(req), status: req.query.status || undefined, search: req.query.q || undefined, limit: limit + 1, offset });
  const more = rows.length > limit;
  res.json({ items: (more ? rows.slice(0, limit) : rows).map(shape), nextCursor: more ? cursorUtil.encode({ o: offset + limit }) : null, total });
});

const get = asyncHandler(async (req, res) => { res.json(detailOf(mustSee(req))); });

const patch = asyncHandler(async (req, res) => {
  const before = mustSee(req);
  const b = req.body;
  if (b.status === undefined && b.notes === undefined) throw new ApiError(400, 'Nothing to change.');
  // A lead becomes converted only by really creating its order, never by a status tap.
  if (b.status === 'converted') throw new ApiError(400, 'Use Convert to order to turn a lead into an order.', null, 'USE_CONVERT');
  if (b.status !== undefined && b.status !== before.status) {
    leads.changeStatus({ leadId: before.id, ...scope(req), toStatus: b.status, staffId: req.user.id, followUpDate: b.followUpDate });
  } else if (b.status === 'rescheduled' && b.followUpDate && b.followUpDate !== before.follow_up_date) {
    throw new ApiError(409, 'This lead is already rescheduled. Mark it contacted first, then reschedule again.', null, 'ALREADY_RESCHEDULED');
  }
  if (b.notes !== undefined) leads.update({ id: before.id, ...scope(req), staffId: req.user.id, notes: b.notes });
  auditV1(req, { action: 'update', entityType: 'lead', entityId: before.id, after: { status: b.status, followUpDate: b.followUpDate, notesChanged: b.notes !== undefined } });
  res.json(detailOf(mustSee(req)));
});

const addActivity = asyncHandler(async (req, res) => {
  mustSee(req);
  const a = leads.addActivity({ id: Number(req.params.id), ...scope(req), type: req.body.type, content: req.body.content, staffId: req.user.id });
  auditV1(req, { action: 'create', entityType: 'lead_activity', entityId: a.id, after: { leadId: Number(req.params.id), type: a.type } });
  res.status(201).json(detailOf(mustSee(req)));
});

const convert = asyncHandler(async (req, res) => {
  const lead = mustSee(req);
  const b = req.body;
  const out = leads.convertToOrder({
    leadId: lead.id, ...scope(req), staffId: req.user.id,
    items: b.items ? b.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })) : undefined,
    city: b.city, notes: b.notes, paymentType: b.paymentType, courierType: b.courierType, mergeIntoOrderId: b.mergeIntoOrderId,
  });
  auditV1(req, { action: 'update', entityType: 'lead', entityId: lead.id, after: { convertedToOrderId: out.orderId, merged: out.merged } });
  const order = require('../services/orders.service').getOrderWithItems(out.orderId, req.user.storeId);
  res.status(out.merged ? 200 : 201).json({ lead: detailOf(mustSee(req)), orderId: out.orderId, orderNumber: order.product_code || `#${order.id}`, merged: out.merged });
});

module.exports = { list, get, patch, addActivity, convert };
