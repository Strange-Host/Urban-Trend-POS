const asyncHandler = require('../utils/asyncHandler');
const receiptsService = require('../services/receipts.service');
const { invoicePdf } = require('../utils/invoicePdf');

// GET /api/orders/:id/receipt — dispatch slip / customer receipt data
const orderReceipt = asyncHandler(async (req, res) => {
  res.json({ data: receiptsService.forOrder({ orderId: Number(req.params.id), storeId: req.user.storeId }) });
});

// GET /api/sales/:id/receipt — till receipt data
const saleReceipt = asyncHandler(async (req, res) => {
  res.json({ data: receiptsService.forSale({ saleId: Number(req.params.id), storeId: req.user.storeId }) });
});

const sendInvoice = async (res, data) => {
  const buffer = await invoicePdf(data);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice_${String(data.reference).replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
};

// GET /api/orders/:id/invoice.pdf and /api/sales/:id/invoice.pdf — same store scoping as the receipts
const orderInvoice = asyncHandler(async (req, res) => sendInvoice(res, receiptsService.forOrder({ orderId: Number(req.params.id), storeId: req.user.storeId })));
const saleInvoice = asyncHandler(async (req, res) => sendInvoice(res, receiptsService.forSale({ saleId: Number(req.params.id), storeId: req.user.storeId })));

module.exports = { orderReceipt, saleReceipt, orderInvoice, saleInvoice };
