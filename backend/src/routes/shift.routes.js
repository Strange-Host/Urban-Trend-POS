const router = require('express').Router();
const ctrl = require('../controllers/shift.controller');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);
router.get('/handover', ctrl.handover); // always scoped to req.user — nothing to gate by role

module.exports = router;
