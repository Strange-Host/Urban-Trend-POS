const asyncHandler = require('../utils/asyncHandler');
const couriersService = require('../services/couriers.service');

// GET /api/couriers?all=1 — everyone signed in can pick a courier on an order;
// ?all=1 (inactive too) is only honoured for people who can manage couriers.
const list = asyncHandler(async (req, res) => {
  const permissionsService = require('../services/permissions.service');
  const includeInactive = req.query.all === '1' && permissionsService.can(req.user, 'couriers.manage');
  res.json({ data: couriersService.list({ storeId: req.user.storeId, includeInactive }) });
});

const create = asyncHandler(async (req, res) => {
  const { name, phone, vehicle, courier_type, notes, kind, collects_payment, contact_person, overdue_limit, overdue_after_days } = req.body;
  const row = couriersService.create({
    storeId: req.user.storeId, staffId: req.user.id, name, phone, vehicle, courierType: courier_type, notes,
    kind, collectsPayment: collects_payment, contactPerson: contact_person, overdueLimit: overdue_limit, overdueAfterDays: overdue_after_days,
  });
  res.status(201).json({ data: row });
});

const update = asyncHandler(async (req, res) => {
  const { name, phone, vehicle, courier_type, notes, is_active, collects_payment, contact_person, overdue_limit, overdue_after_days } = req.body;
  const row = couriersService.update({
    id: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id,
    name, phone, vehicle, courierType: courier_type, notes, isActive: is_active,
    collectsPayment: collects_payment, contactPerson: contact_person, overdueLimit: overdue_limit, overdueAfterDays: overdue_after_days,
  });
  res.json({ data: row });
});

const remove = asyncHandler(async (req, res) => {
  res.json({ data: couriersService.deactivate({ id: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id }) });
});

// --- Courier organizations: collections, statements, standing (services/courierOrganizations.service.js)
const orgs = require('../services/courierOrganizations.service');
const scope = (req) => ({ storeId: req.user.storeId, courierId: Number(req.params.id) });

const standing = asyncHandler(async (req, res) => {
  res.json({ data: orgs.organizationStanding(scope(req)) });
});
const openCollections = asyncHandler(async (req, res) => {
  res.json({ data: orgs.listOpenCollections(scope(req)) });
});
const statements = asyncHandler(async (req, res) => {
  res.json({ data: orgs.listStatements(scope(req)) });
});
const recordCollection = asyncHandler(async (req, res) => {
  const { order_id, amount, collected_on } = req.body;
  const row = orgs.recordCollection({ ...scope(req), staffId: req.user.id, orderId: order_id, amount, collectedOn: collected_on });
  res.status(201).json({ data: row });
});
const createStatement = asyncHandler(async (req, res) => {
  const b = req.body;
  const row = orgs.createStatement({
    ...scope(req), staffId: req.user.id, periodStart: b.period_start, periodEnd: b.period_end, collectionIds: b.collection_ids,
    chargeEntered: b.charge_entered, remitted: b.remitted, remittanceRef: b.remittance_ref,
  });
  res.status(201).json({ data: row });
});

module.exports = { list, create, update, remove, standing, openCollections, statements, recordCollection, createStatement };
