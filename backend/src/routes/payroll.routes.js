const router = require('express').Router();
const ctrl = require('../controllers/payroll.controller');
const { authenticate, requirePermission, requireRole } = require('../middleware/auth');

router.use(authenticate, requirePermission('payroll.view'));

router.get('/summary', ctrl.getSummary);
router.post('/loss-deduction', ctrl.recordLossDeduction);

// Locked payroll runs. Anyone who can view payroll can calculate a draft; locking and paying are admin-only.
router.get('/runs', ctrl.listRuns);
router.post('/runs', ctrl.generateDraft);
router.get('/runs/:id', ctrl.getRun);
router.get('/runs/:id/verify', ctrl.verifyRun);
router.post('/runs/:id/approve', requireRole('admin'), ctrl.approveRun);
router.post('/runs/:id/pay', requireRole('admin'), ctrl.payRun);

module.exports = router;
