const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/leadIntake.controller');
const { requireIntakeSecret } = require('../middleware/leadIntakeAuth');
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createRouteSchema, updateRouteSchema } = require('../validation/leadIntake.schema');

const intakeLimiter = rateLimit({ ...RATE_LIMITS.WEBHOOK, standardHeaders: true });

// Public-facing, secret-protected: the website posts here.
router.post('/intake', intakeLimiter, requireIntakeSecret, ctrl.intake);

// Admin-only: show the (auto-generated) secret so it can be pasted into the form plugin.
router.get('/secret', authenticate, requireRole('admin'), ctrl.secret);

// Staff-facing: manage which form feeds which product / rep.
router.get('/routes', authenticate, requirePermission('leads.intake_routes'), ctrl.listRoutes);
router.post('/routes', authenticate, requirePermission('leads.intake_routes'), validate(createRouteSchema), ctrl.createRoute);
router.patch('/routes/:id', authenticate, requirePermission('leads.intake_routes'), validate(updateRouteSchema), ctrl.updateRoute);
router.delete('/routes/:id', authenticate, requirePermission('leads.intake_routes'), ctrl.removeRoute);

module.exports = router;
