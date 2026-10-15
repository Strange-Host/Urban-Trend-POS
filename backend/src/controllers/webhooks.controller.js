const asyncHandler = require('../utils/asyncHandler');
const liveSync = require('../services/liveSync.service');

// Public endpoints the stores call. Authentication is the store's own HMAC signature over the raw
// request body (checked in liveSync.receive) - not a login, and not a secret in the address.
const make = (platform) => asyncHandler(async (req, res) => {
  const out = await liveSync.receive({
    platform, sourceId: Number(req.params.sourceId), headers: req.headers, rawBody: req.rawBody, body: req.body,
  });
  res.status(out.httpStatus).json(out.body);
});

module.exports = { shopify: make('shopify'), woocommerce: make('woocommerce') };
