const router = require('express').Router();
const ctrl = require('../controllers/settings.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin'));

router.get('/', ctrl.getAll);
router.put('/', ctrl.update);

module.exports = router;
