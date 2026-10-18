const securityAlerts = require('../services/securityAlerts.service');

// Route middleware: when the request succeeds, tell the admins that something sensitive was changed
// (connection details for an online store, payment provider, SMS or email, or business settings).
//   router.put('/credentials', requireRecentAuth(), alertOnChange('SMS provider details'), ctrl.save)
module.exports = (what) => (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400 && req.user) {
      securityAlerts.credentialsChanged({ storeId: req.user.storeId, actor: { id: req.user.id, name: req.user.name }, what });
    }
  });
  next();
};
