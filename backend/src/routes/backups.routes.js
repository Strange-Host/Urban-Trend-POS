const router = require('express').Router();
const ctrl = require('../controllers/backups.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Backup files are effectively a full copy of the database, including
// every connected store's encrypted credentials and every user's password
// hash — admin-only, same bar as Settings/Income sources.
router.use(authenticate, requireRole('admin'));

router.get('/', ctrl.list);
router.post('/run', ctrl.run);
router.post('/email-now', ctrl.emailNow);

module.exports = router;
