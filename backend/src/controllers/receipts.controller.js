const asyncHandler = require('../utils/asyncHandler');
const receiptsService = require('../services/receipts.service');

// GET /api/orders/:id/receipt — dispatch slip / customer receipt data
const orderReceipt = asyncHandler(async (req, res) => {
  res.json({ data: receiptsService.forOrder({ orderId: Number(req.params.id), storeId: req.user.storeId }) });
});

// GET /api/sales/:id/receipt — till receipt data
const saleReceipt = asyncHandler(async (req, res) => {
  res.json({ data: receiptsService.forSale({ saleId: Number(req.params.id), storeId: req.user.storeId }) });
});

module.exports = { orderReceipt, saleReceipt };
