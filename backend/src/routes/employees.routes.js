const router = require('express').Router();
const ctrl = require('../controllers/employees.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Onboarding a new hire, uploading their documents, and witnessing their
// signature are all admin actions (§11: "Admin creates employee profile") —
// same reasoning as the account-management block in users.routes.js.
router.use(authenticate, requireRole('admin'));

router.post('/onboard', ctrl.onboard);
router.get('/:id/onboarding-status', ctrl.getOnboardingStatus);
router.post('/:id/documents', ctrl.uploadDocument);
router.post('/:id/sign-agreement', ctrl.signAgreement);

module.exports = router;
