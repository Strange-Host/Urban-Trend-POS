const asyncHandler = require('../utils/asyncHandler');
const areas = require('../services/deliveryAreas.service');
const settingsService = require('../services/settings.service');

// GET /api/delivery-areas?all=1&search= — everyone signed in (the order screen shows the fee);
// ?all=1 also lists switched-off areas.
const list = asyncHandler(async (req, res) => {
  res.json({ data: areas.list({ includeInactive: req.query.all === '1', search: req.query.search }) });
});

// GET /api/delivery-areas/lookup?town=&total= — what fee would an order to this town carry?
const lookup = asyncHandler(async (req, res) => {
  const totalCents = Math.max(parseInt(req.query.total, 10) || 0, 0);
  const { fee, area, source } = areas.resolveFee({ town: req.query.town, totalCents, settings: settingsService.getAll() });
  res.json({ data: { fee, source, area: area ? { id: area.id, area_name: area.area_name, courier_type: area.courier_type } : null } });
});

const create = asyncHandler(async (req, res) => {
  const { area_name, fee, courier_type, notes } = req.body;
  res.status(201).json({ data: areas.create({ staffId: req.user.id, areaName: area_name, fee, courierType: courier_type, notes }) });
});

const update = asyncHandler(async (req, res) => {
  const { area_name, fee, courier_type, notes, is_active } = req.body;
  res.json({ data: areas.update({ id: Number(req.params.id), staffId: req.user.id, areaName: area_name, fee, courierType: courier_type, notes, isActive: is_active }) });
});

const remove = asyncHandler(async (req, res) => {
  areas.remove({ id: Number(req.params.id), staffId: req.user.id });
  res.json({ data: { deleted: true } });
});

const importRows = asyncHandler(async (req, res) => {
  res.json({ data: areas.importRows({ staffId: req.user.id, rows: req.body.rows }) });
});

module.exports = { list, lookup, create, update, remove, importRows };
