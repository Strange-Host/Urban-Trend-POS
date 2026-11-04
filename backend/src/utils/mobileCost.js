const permissionsService = require('../services/permissions.service');

// Buying price and margin are confidential. In the mobile API they are only ever sent to someone holding
// 'products.view_cost', and for everyone else the KEYS ARE ABSENT (not null, not 0). One helper for the whole v1 layer,
// so a new endpoint cannot forget.
const canSeeCost = (user) => permissionsService.can(user, 'products.view_cost');

function stripCost(obj) {
  if (!obj) return obj;
  const { costPriceCents, marginCents, ...rest } = obj; // eslint-disable-line no-unused-vars
  return rest;
}
const forUser = (user, obj) => (canSeeCost(user) ? obj : stripCost(obj));

module.exports = { canSeeCost, stripCost, forUser };
