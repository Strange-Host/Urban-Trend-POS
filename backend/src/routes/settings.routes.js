const router = require('express').Router();
const ctrl = require('../controllers/settings.controller');
const { authenticate, requireRole, requireRecentAuth } = require('../middleware/auth');
const alertOnChange = require('../middleware/alertOnChange');

router.use(authenticate, requireRole('admin'));

router.get('/', ctrl.getAll);
router.put('/', requireRecentAuth(), ctrl.update);

module.exports = router;
