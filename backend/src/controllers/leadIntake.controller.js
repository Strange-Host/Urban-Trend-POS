const asyncHandler = require('../utils/asyncHandler');
const leadIntake = require('../services/leadIntake.service');
const db = require('../config/db');

// POST /api/integrations/leads/intake — called by the website form plugin.
// Always answers 200 for anything that was understood (including a repeat
// customer or a replayed delivery), so the plugin never keeps retrying and
// never shows the customer an error for something that isn't their fault.
const intake = asyncHandler(async (req, res) => {
  const store = db.prepare('SELECT id FROM stores WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  const result = leadIntake.intake({ storeId: store.id, body: req.body });
  res.status(result.outcome === 'created' ? 201 : 200).json({ status: result.outcome, leadId: result.leadId });
});

const listRoutes = asyncHandler(async (req, res) => {
  res.json({ data: leadIntake.listRoutes(req.user.storeId) });
});

const createRoute = asyncHandler(async (req, res) => {
  const { form_name, product_id, assigned_staff_id } = req.body;
  res.status(201).json({ data: leadIntake.createRoute({ storeId: req.user.storeId, staffId: req.user.id, formName: form_name, productId: product_id, assignedStaffId: assigned_staff_id }) });
});

const updateRoute = asyncHandler(async (req, res) => {
  const { form_name, product_id, assigned_staff_id, is_active } = req.body;
  res.json({ data: leadIntake.updateRoute({ storeId: req.user.storeId, staffId: req.user.id, id: Number(req.params.id), formName: form_name, productId: product_id, assignedStaffId: assigned_staff_id, isActive: is_active }) });
});

const removeRoute = asyncHandler(async (req, res) => {
  res.json({ data: leadIntake.removeRoute({ storeId: req.user.storeId, staffId: req.user.id, id: Number(req.params.id) }) });
});

// GET /api/integrations/leads/secret - admin only. The secret is generated for
// you on first run; this is how you copy it into the website form plugin without
// opening files on the server. Never cached.
const secret = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: { header: 'X-Intake-Secret', secret: process.env.LEAD_INTAKE_SECRET || null, path: '/api/integrations/leads/intake' } });
});

module.exports = { secret, intake, listRoutes, createRoute, updateRoute, removeRoute };
