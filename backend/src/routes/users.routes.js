const requireModule = require('../middleware/requireModule');
const router = require('express').Router();
const ctrl = require('../controllers/users.controller');
const { authenticate, requireRole, requirePermission, requireRecentAuth } = require('../middleware/auth');

router.use(authenticate);

// Read access: admin + manager (managers need this to assign leads to staff).
router.get('/', requirePermission('staff.view'), ctrl.list);
router.get('/:id', requirePermission('staff.view'), ctrl.getById);

// Account management: admin only (§5.2 "Manage Staff accounts").
router.use(requireRole('admin'));
// Every change to a staff account asks for the admin's password (or at least a recent confirmation) first.
router.use(requireRecentAuth({ writesOnly: true }));
router.get('/:id/removal-check', ctrl.removalCheck);
router.get('/:id/sessions', ctrl.sessionsFor);
router.post('/:id/reactivate', ctrl.reactivate);
router.post('/:id/permanent-delete', ctrl.permanentDelete);
router.post('/:id/erase-personal-data', ctrl.erasePersonalData);
router.post('/:id/sign-out-everywhere', ctrl.signOutEverywhere);
router.post('/:id/unlock-account', ctrl.unlockAccount);
router.post('/', ctrl.create);
router.patch('/:id', ctrl.update);
router.put('/:id', ctrl.update); // kept for backward compatibility with any existing PUT callers
router.delete('/:id', ctrl.remove);
router.post('/:id/reset-password', ctrl.resetPassword);
// Control extras: while switched off these screens' APIs are closed. Overrides and 2FA that were
// already set keep being enforced at sign-in / on each request - only changing them is closed.
router.get('/:id/permissions', requireModule('control'), ctrl.getPermissions);
router.put('/:id/permissions', requireModule('control'), ctrl.setPermissions);
router.patch('/:id/two-factor', requireModule('control'), ctrl.setTwoFactor);

module.exports = router;
