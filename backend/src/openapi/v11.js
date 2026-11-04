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
];

module.exports = { ENDPOINTS, helpers: { err, UNAUTH, BAD, FORBIDDEN, NOT_FOUND, CONFLICT, idParam, pageQuery } };
