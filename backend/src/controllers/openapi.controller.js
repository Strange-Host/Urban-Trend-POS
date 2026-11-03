const asyncHandler = require('../utils/asyncHandler');
const { build } = require('../openapi/v1');

// The document only changes when the code does, so build it once.
let doc = null;

// GET /api/v1/openapi.json - public: the app's typed client is generated from it, and it describes shapes, not data.
const get = asyncHandler(async (req, res) => {
  if (!doc) doc = build();
  res.set('Cache-Control', 'public, max-age=300');
  res.json(doc);
});

module.exports = { get };
