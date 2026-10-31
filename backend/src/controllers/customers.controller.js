const asyncHandler = require('../utils/asyncHandler');
const customersService = require('../services/customers.service');
const { parsePagination, paginatedResponse } = require('../utils/paginate');

// GET /api/customers/:id/orders and GET /api/customers/orders?phone=...
const history = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { customer, rows, total, summary } = customersService.orderHistory({
    storeId: req.user.storeId, customerId: req.params.id, phone: req.query.phone, limit, offset,
  });
  res.json({ ...paginatedResponse({ rows, total, page, limit }), customer, summary });
});

module.exports = { history };
