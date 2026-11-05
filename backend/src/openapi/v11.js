const { z } = require('zod');
const req = require('../validation/mobile.v11.schema');
const res = require('../validation/mobile.v11.responses');

// The v1.1 endpoints (catalog, categories, bulk prices, stock-takes, payment matching, courier remittance, attendance),
// appended to the list in openapi/v1.js. Same rule as there: add the route to routes/v1/index.js AND an entry here.

const err = (description) => ({ description, schema: res.ErrorResponse });
const UNAUTH = err('Missing, invalid, expired or revoked access token');
const BAD = err('The request body or query is invalid');
const FORBIDDEN = err('The signed-in person may not do this (code FORBIDDEN)');
const NOT_FOUND = err('Not found');
const CONFLICT = err('The request conflicts with the current state (a specific code says how)');
const idParam = { name: 'id', description: 'The id', schema: { type: 'integer' } };
const pageQuery = [
  { name: 'cursor', description: 'The nextCursor from the previous page', schema: { type: 'string' } },
  { name: 'limit', description: '1 to 100, default 30', schema: { type: 'integer' } },
];

const ENDPOINTS = [
  // ---- catalog
  {
    method: 'get', path: '/products', tag: 'Catalog', auth: true, operationId: 'listProducts',
    summary: 'Find products', description: 'Needs products.manage. costPriceCents and marginCents are only present with products.view_cost.',
    query: [
      { name: 'q', description: 'Name, SKU or barcode contains', schema: { type: 'string' } },
      { name: 'categoryId', description: 'Only this category', schema: { type: 'integer' } },
      { name: 'active', description: '1 (default) active products, 0 switched-off ones', schema: { type: 'string', enum: ['0', '1'] } },
      { name: 'catalogue', description: 'shop (default) or online', schema: { type: 'string', enum: ['shop', 'online'] } },
      ...pageQuery,
    ],
    responses: { 200: { description: 'A page of products, by name', schema: res.ProductList }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'post', path: '/products', tag: 'Catalog', auth: true, operationId: 'createProduct',
    summary: 'Add a product', body: req.createProduct,
    responses: { 201: { description: 'Created', schema: res.Product }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 409: err('DUPLICATE_SKU or DUPLICATE_BARCODE') },
  },
  {
    method: 'get', path: '/products/{id}', tag: 'Catalog', auth: true, operationId: 'getProduct', summary: 'One product', pathParams: [idParam],
    responses: { 200: { description: 'The product', schema: res.Product }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'patch', path: '/products/{id}', tag: 'Catalog', auth: true, operationId: 'updateProduct',
    summary: 'Edit a product', pathParams: [idParam], body: req.patchProduct,
    description: 'Changing the selling price needs a reason (REASON_REQUIRED) and is written to the price history. Sending a cost without products.view_cost is FORBIDDEN. Products are deactivated with isActive:false, never deleted.',
    responses: { 200: { description: 'The product as it is now', schema: res.Product }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('DUPLICATE_SKU or DUPLICATE_BARCODE') },
  },
  {
    method: 'get', path: '/products/{id}/price-history', tag: 'Catalog', auth: true, operationId: 'getPriceHistory',
    summary: 'Who changed this price, when and why', pathParams: [idParam], query: pageQuery,
    responses: { 200: { description: 'Newest first', schema: res.PriceHistory }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/catalog/settings', tag: 'Catalog', auth: true, operationId: 'getCatalogSettings',
    summary: 'Which system sets the shop price',
    responses: { 200: { description: 'Price master settings', schema: res.CatalogSettings }, 401: UNAUTH, 403: FORBIDDEN },
  },

  // ---- categories
  {
    method: 'get', path: '/categories', tag: 'Catalog', auth: true, operationId: 'listCategories', summary: 'Categories in display order',
    query: [{ name: 'includeInactive', description: '1 = include deactivated ones', schema: { type: 'string', enum: ['0', '1'] } }],
    responses: { 200: { description: 'All categories (not paged)', schema: res.CategoryList }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'post', path: '/categories', tag: 'Catalog', auth: true, operationId: 'createCategory', summary: 'Add a category', body: req.createCategory,
    responses: { 201: { description: 'Created', schema: res.Category }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 409: err('DUPLICATE_NAME') },
  },
  {
    method: 'post', path: '/categories/reorder', tag: 'Catalog', auth: true, operationId: 'reorderCategories', summary: 'Set the display order',
    body: req.reorderCategories,
    responses: { 200: { description: 'All categories in the new order', schema: res.CategoryList }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'patch', path: '/categories/{id}', tag: 'Catalog', auth: true, operationId: 'updateCategory',
    summary: 'Rename, deactivate or restore a category', pathParams: [idParam], body: req.patchCategory,
    description: 'isActive:false hides it from pickers; the products filed under it are not touched.',
    responses: { 200: { description: 'The category', schema: res.Category }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('DUPLICATE_NAME') },
  },

  // ---- bulk prices
  {
    method: 'post', path: '/prices/bulk/preview', tag: 'Prices', auth: true, operationId: 'previewBulkPrice',
    summary: 'See exactly what a bulk price change would do', body: req.bulkChange,
    description: 'Needs prices.bulk. Changes nothing. Prices are rounded to the nearest whole shilling (halves up). Products whose new price is zero or less, or unchanged, are listed as skipped.',
    responses: { 200: { description: 'Old and new price for every affected product, and a fingerprint to apply with', schema: res.BulkPreview }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 422: err('TOO_MANY') },
  },
  {
    method: 'post', path: '/prices/bulk/apply', tag: 'Prices', auth: true, operationId: 'applyBulkPrice',
    summary: 'Apply a previewed bulk price change as one batch', body: req.bulkApply,
    description: 'The server recomputes; if the result differs from the preview (fingerprint) nothing is applied (PREVIEW_STALE).',
    responses: { 201: { description: 'Applied', schema: res.BulkApplied }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 409: err('PREVIEW_STALE'), 422: err('TOO_MANY or NOTHING_TO_CHANGE') },
  },
  {
    method: 'get', path: '/prices/bulk/batches', tag: 'Prices', auth: true, operationId: 'listBulkPriceBatches', summary: 'Recent bulk price changes and reverts', query: pageQuery,
    responses: { 200: { description: 'Newest first', schema: res.BulkBatches }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'post', path: '/prices/bulk/{batchId}/revert', tag: 'Prices', auth: true, operationId: 'revertBulkPrice',
    summary: 'Undo a bulk price change with a new batch', body: req.bulkRevert,
    pathParams: [{ name: 'batchId', description: 'The batch to undo', schema: { type: 'integer' } }],
    description: 'Only products still at the price the batch gave them are reverted; the rest are reported as skipped.',
    responses: { 201: { description: 'Reverted', schema: res.BulkReverted }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('ALREADY_REVERTED, NOT_REVERTIBLE or NOTHING_TO_REVERT') },
  },

  // ---- stock-take
  {
    method: 'post', path: '/stock-takes', tag: 'Stock-take', auth: true, operationId: 'startStockTake',
    summary: 'Start a stock-take sheet, or resume your open one for the same area', body: req.startStockTake,
    description: 'Needs stock.count. The draft lives on the server, so nothing counted is lost if the app is closed.',
    responses: { 200: { description: 'Your existing draft for that area', schema: res.StockTake }, 201: { description: 'A new draft', schema: res.StockTake }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/stock-takes', tag: 'Stock-take', auth: true, operationId: 'listStockTakes', summary: 'Stock-takes (yours, or everyone\'s with stock.review)',
    query: [{ name: 'status', description: 'draft, applied, pending_approval or rejected', schema: { type: 'string' } }, { name: 'mine', description: '1 = only mine', schema: { type: 'string' } }, ...pageQuery],
    responses: { 200: { description: 'Newest first', schema: res.StockTakeList }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/stock-takes/{id}', tag: 'Stock-take', auth: true, operationId: 'getStockTake', summary: 'One stock-take with its counted lines', pathParams: [idParam],
    responses: { 200: { description: 'systemQty is live while a draft and frozen at submit', schema: res.StockTakeDetail }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'post', path: '/stock-takes/{id}/lines', tag: 'Stock-take', auth: true, operationId: 'saveStockTakeLines',
    summary: 'Save counted quantities (up to 500 per call)', pathParams: [idParam], body: req.stockTakeLines,
    description: 'Idempotent: sending a product again replaces its count. All-or-nothing. Only the creator, only while a draft.',
    responses: { 200: { description: 'The draft with its lines', schema: res.StockTakeDetail }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NOT_DRAFT'), 422: err('NOT_IN_SCOPE') },
  },
  {
    method: 'post', path: '/stock-takes/{id}/submit', tag: 'Stock-take', auth: true, operationId: 'submitStockTake',
    summary: 'Submit the sheet', pathParams: [idParam],
    description: 'Differences up to the approval limit are applied to stock now; bigger ones wait for an owner or manager. Products not counted are left alone.',
    responses: { 200: { description: 'What was applied and what waits', schema: res.StockTakeSubmitted }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NOT_DRAFT'), 422: err('NO_LINES') },
  },
  {
    method: 'post', path: '/stock-takes/{id}/approve', tag: 'Stock-take', auth: true, operationId: 'approveStockTake',
    summary: 'Approve the big differences (stock.review)', pathParams: [idParam], body: req.approveStockTake,
    responses: { 200: { description: 'Applied', schema: res.StockTakeDetail }, 401: UNAUTH, 403: err('FORBIDDEN or SELF_APPROVAL'), 404: NOT_FOUND, 409: err('NOT_PENDING') },
  },
  {
    method: 'post', path: '/stock-takes/{id}/reject', tag: 'Stock-take', auth: true, operationId: 'rejectStockTake',
    summary: 'Reject the big differences (stock.review)', pathParams: [idParam], body: req.rejectStockTake,
    responses: { 200: { description: 'Rejected', schema: res.StockTakeDetail }, 400: BAD, 401: UNAUTH, 403: err('FORBIDDEN or SELF_APPROVAL'), 404: NOT_FOUND, 409: err('NOT_PENDING') },
  },

  // ---- unmatched payments
  {
    method: 'get', path: '/payments/unmatched', tag: 'Payments', auth: true, operationId: 'listUnmatchedPayments', summary: 'Money received that is not tied to an order (oldest first)',
    description: 'Needs payments.reconcile.', query: pageQuery,
    responses: { 200: { description: 'A page, plus the total waiting', schema: res.UnmatchedPayments }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/payments/{id}/suggestions', tag: 'Payments', auth: true, operationId: 'getPaymentSuggestions', summary: 'Orders this payment probably belongs to',
    pathParams: [idParam], query: [{ name: 'q', description: 'Also offer orders whose customer name, phone or code contains this', schema: { type: 'string' } }],
    description: 'Only orders that can still take a payment. Best first, at most 5. A hint for a person to confirm.',
    responses: { 200: { description: 'Suggested orders', schema: res.PaymentSuggestions }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('ALREADY_MATCHED or ALREADY_IGNORED') },
  },
  {
    method: 'post', path: '/payments/{id}/match', tag: 'Payments', auth: true, operationId: 'matchPayment', summary: 'Match a payment to an order', pathParams: [idParam], body: req.matchPayment,
    description: 'The payment is counted as revenue exactly once. A payment already matched is refused (ALREADY_MATCHED).',
    responses: { 200: { description: 'Matched', schema: res.PaymentMatched }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: err('NOT_FOUND or ORDER_NOT_FOUND'), 409: err('ALREADY_MATCHED, ALREADY_IGNORED or ORDER_NOT_PAYABLE'), 422: err('AMOUNT_EXCEEDS_BALANCE') },
  },
  {
    method: 'post', path: '/payments/{id}/ignore', tag: 'Payments', auth: true, operationId: 'ignorePayment', summary: 'Set a payment aside, with a reason', pathParams: [idParam], body: req.ignorePayment,
    responses: { 200: { description: 'Ignored', schema: res.PaymentIgnored }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('ALREADY_MATCHED or ALREADY_IGNORED') },
  },

  // ---- courier remittance
  {
    method: 'get', path: '/couriers/balances', tag: 'Couriers', auth: true, operationId: 'getCourierBalances', summary: 'What each courier organization still owes the shop',
    description: 'Needs couriers.settle. Collected, minus remitted, minus the fees we owe them.',
    responses: { 200: { description: 'Biggest balance first', schema: res.CourierBalances }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/couriers/{id}/collections', tag: 'Couriers', auth: true, operationId: 'getCourierCollections', summary: 'Parcels the courier collected for that are not yet settled',
    pathParams: [idParam], responses: { 200: { description: 'Open collections, oldest first', schema: res.CourierCollections }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/couriers/{id}/remittances', tag: 'Couriers', auth: true, operationId: 'listCourierRemittances', summary: 'Past remittances from this courier', pathParams: [idParam], query: pageQuery,
    responses: { 200: { description: 'Newest first', schema: res.CourierRemittances }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'post', path: '/couriers/{id}/remittances', tag: 'Couriers', auth: true, operationId: 'createCourierRemittance', summary: 'Record money received from a courier', pathParams: [idParam], body: req.createRemittance,
    description: 'Cannot be undone. Settling a parcel twice is refused (ALREADY_SETTLED). No receipt photo in this release.',
    responses: { 201: { description: 'Recorded', schema: res.RemittanceCreated }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('ALREADY_SETTLED or another STATEMENT_* code'), 422: err('A STATEMENT_* code explaining what is wrong with the amounts') },
  },

  // ---- attendance
  {
    method: 'get', path: '/attendance/me', tag: 'Attendance', auth: true, operationId: 'getMyAttendance', summary: 'My shift today',
    description: 'Only while the HR module is on. gate says what clocking out will be checked against.',
    responses: { 200: { description: 'Today\'s shift', schema: res.AttendanceToday }, 401: UNAUTH, 404: err('MODULE_DISABLED') },
  },
  {
    method: 'post', path: '/attendance/clock-in', tag: 'Attendance', auth: true, operationId: 'clockIn', summary: 'Clock in (yourself only)', body: req.clockIn,
    description: 'Needs confirm:true. No location is read or stored.',
    responses: { 201: { description: 'Clocked in', schema: res.AttendanceToday }, 400: err('CONFIRM_REQUIRED'), 401: UNAUTH, 404: err('MODULE_DISABLED'), 409: err('ALREADY_CLOCKED_IN') },
  },
  {
    method: 'post', path: '/attendance/clock-out', tag: 'Attendance', auth: true, operationId: 'clockOut', summary: 'Clock out (yourself only)', body: req.clockOut,
    description: 'The website\'s clock-out gate runs first; a refusal keeps you clocked in (CLOCKOUT_* codes).',
    responses: { 200: { description: 'Clocked out', schema: res.AttendanceToday }, 401: UNAUTH, 404: err('MODULE_DISABLED'), 409: err('NOT_CLOCKED_IN or ALREADY_CLOCKED_OUT'), 422: err('CLOCKOUT_CONFIRMATION_REQUIRED, CLOCKOUT_CONFIRMATION_FALSE, CLOCKOUT_REASON_REQUIRED or CLOCKOUT_BLOCKED') },
  },
];

module.exports = { ENDPOINTS, helpers: { err, UNAUTH, BAD, FORBIDDEN, NOT_FOUND, CONFLICT, idParam, pageQuery } };
