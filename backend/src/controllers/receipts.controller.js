const asyncHandler = require('../utils/asyncHandler');
const receiptsService = require('../services/receipts.service');
const { invoicePdf } = require('../utils/invoicePdf');
const { receiptToEscPos, drawerKick } = require('../utils/escpos');

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

// Raw ESC/POS bytes for a thermal printer, for the print bridge (see print-bridge/README.md).
//   ?cols=48 (32 for a 58 mm roll)   ?cut=0 to skip the paper cut   ?drawer=1 to open the cash drawer too   ?drawer=cash only when the sale took cash
const sendEscPos = (res, receipt, query) => {
  const cols = parseInt(query.cols, 10);
  const buffer = receiptToEscPos(receipt, { cols: Number.isFinite(cols) ? cols : 48, cut: query.cut !== '0', drawer: query.drawer === '1' || (query.drawer === 'cash' && (receipt.payments || []).some((p) => p.method === 'cash')) });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
};
const saleEscPos = asyncHandler(async (req, res) => sendEscPos(res, receiptsService.forSale({ saleId: Number(req.params.id), storeId: req.user.storeId }), req.query));
const orderEscPos = asyncHandler(async (req, res) => sendEscPos(res, receiptsService.forOrder({ orderId: Number(req.params.id), storeId: req.user.storeId }), req.query));

// GET /api/sales/drawer.escpos — just the pulse that opens the cash drawer ("no sale")
const drawerEscPos = asyncHandler(async (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.send(drawerKick());
});

module.exports = { orderReceipt, saleReceipt, orderInvoice, saleInvoice, saleEscPos, orderEscPos, drawerEscPos };
