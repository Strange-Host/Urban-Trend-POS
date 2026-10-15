const ApiError = require('../utils/ApiError');
const modules = require('../services/modules.service');

// Blocks a route while its optional module is switched off. 404 (not 403): as far as the API is
// concerned the feature does not exist until an admin turns it on.
const LABEL = { hr: 'HR & back office', control: 'Control extras' };

module.exports = (name) => (req, _res, next) => {
  if (modules.isEnabled(name)) return next();
  return next(new ApiError(404, `${LABEL[name] || name} is turned off. An admin can turn it on under Settings > Business > Optional modules.`, null, 'MODULE_DISABLED'));
};
