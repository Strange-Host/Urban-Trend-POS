const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const leadsService = require('../services/leads.service');

// GET /api/leads?status=&source=&assigned_staff_id=&search=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total } = leadsService.list({
    storeId: req.user.storeId, role: req.user.role, userId: req.user.id,
    status: req.query.status, source: req.query.source, assignedStaffId: req.query.assigned_staff_id,
    search: req.query.search, limit, offset,
  });
  res.json(paginatedResponse({ rows, total, page, limit }));
});

// GET /api/leads/stats — counts by status, for dashboard cards (§1.4)
const stats = asyncHandler(async (req, res) => {
  const data = leadsService.getStats({ storeId: req.user.storeId, role: req.user.role, userId: req.user.id });
  res.json({ data });
});

// GET /api/leads/:id — includes activities + status history, joined
const getById = asyncHandler(async (req, res) => {
  const lead = leadsService.getById({ id: req.params.id, storeId: req.user.storeId, role: req.user.role, userId: req.user.id });
  if (!lead) throw new ApiError(404, 'Lead not found.');
  res.json({ data: lead });
});

// POST /api/leads
const create = asyncHandler(async (req, res) => {
  const { name, phone, email, source, notes, assigned_staff_id } = req.body;
  const lead = leadsService.create({
    storeId: req.user.storeId, staffId: req.user.id,
    name, phone, email, source, notes, assignedStaffId: assigned_staff_id,
  });
  res.status(201).json({ data: lead });
});

// PATCH /api/leads/:id — general field edits (not status; see changeStatus)
const update = asyncHandler(async (req, res) => {
  const lead = leadsService.update({
    id: req.params.id, storeId: req.user.storeId, role: req.user.role, userId: req.user.id, staffId: req.user.id,
    name: req.body.name, phone: req.body.phone, email: req.body.email, notes: req.body.notes,
    assignedStaffId: req.body.assigned_staff_id, convertedOrderId: req.body.converted_order_id,
  });
  if (!lead) throw new ApiError(404, 'Lead not found.');
  res.json({ data: lead });
});

// PATCH /api/leads/:id/status — dedicated endpoint, enforces the state machine
const changeStatus = asyncHandler(async (req, res) => {
  const { status, follow_up_date } = req.body;
  if (!status) throw new ApiError(400, 'status is required.');

  const lead = leadsService.changeStatus({
    leadId: req.params.id, storeId: req.user.storeId, role: req.user.role, userId: req.user.id,
    toStatus: status, staffId: req.user.id, followUpDate: follow_up_date,
  });
  res.json({ data: lead });
});

// POST /api/leads/:id/convert — create the order from the lead and mark it converted, in one transaction
const convert = asyncHandler(async (req, res) => {
  const b = req.body;
  const result = leadsService.convertToOrder({
    leadId: req.params.id, storeId: req.user.storeId, role: req.user.role, userId: req.user.id, staffId: req.user.id,
    items: b.items, city: b.city, discountTotal: b.discount_total, notes: b.notes,
    paymentType: b.payment_type, courierType: b.courier_type, mergeIntoOrderId: b.merge_into_order_id,
  });
  const order = require('../services/orders.service').getOrderWithItems(result.orderId, req.user.storeId);
  res.status(result.merged ? 200 : 201).json({ data: { lead: result.lead, order, merged: result.merged } });
});

// POST /api/leads/:id/activities
const addActivity = asyncHandler(async (req, res) => {
  const activity = leadsService.addActivity({
    id: req.params.id, storeId: req.user.storeId, role: req.user.role, userId: req.user.id,
    type: req.body.type, content: req.body.content, staffId: req.user.id,
  });
  if (!activity) throw new ApiError(404, 'Lead not found.');
  res.status(201).json({ data: activity });
});

// DELETE /api/leads/:id — soft delete
const remove = asyncHandler(async (req, res) => {
  const ok = leadsService.remove({ id: req.params.id, storeId: req.user.storeId, staffId: req.user.id });
  if (!ok) throw new ApiError(404, 'Lead not found.');
  res.status(204).send();
});

module.exports = { list, stats, getById, create, update, changeStatus, convert, addActivity, remove };
