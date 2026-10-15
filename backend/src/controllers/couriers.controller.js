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
  const { name, phone, vehicle, courier_type, notes } = req.body;
  const row = couriersService.create({ storeId: req.user.storeId, staffId: req.user.id, name, phone, vehicle, courierType: courier_type, notes });
  res.status(201).json({ data: row });
});

const update = asyncHandler(async (req, res) => {
  const { name, phone, vehicle, courier_type, notes, is_active } = req.body;
  const row = couriersService.update({
    id: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id,
    name, phone, vehicle, courierType: courier_type, notes, isActive: is_active,
  });
  res.json({ data: row });
});

const remove = asyncHandler(async (req, res) => {
  res.json({ data: couriersService.deactivate({ id: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id }) });
});

module.exports = { list, create, update, remove };
