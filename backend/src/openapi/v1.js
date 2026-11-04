const { z } = require('zod');
const req = require('../validation/mobile.schema');
const res = require('../validation/mobile.responses');

// The OpenAPI 3.1 description of /api/v1, generated from the same zod schemas the routes validate with (requests) and the
// contract tests check against (responses). The typed client for the app is generated from this document, so a change to a
// schema reaches the app's types with no hand-copying.
//
// To add an endpoint: add it to the router (routes/v1/index.js) AND to ENDPOINTS below. tests/mobileOpenApi.test.js fails
// if the two lists ever disagree, so an endpoint cannot ship undocumented.

const err = (description) => ({ description, schema: res.ErrorResponse });
const UNAUTH = err('Missing, invalid, expired or revoked access token (code SESSION_EXPIRED when the sign-in has ended)');
const BAD = err('The request body or query is invalid');
const FORBIDDEN = err('The signed-in person may not do this (code FORBIDDEN)');
const NOT_FOUND = err('Not found, or not yours');
const LIMITED = err('Too many attempts, or the account is temporarily locked (code ACCOUNT_LOCKED / RATE_LIMITED)');

const ENDPOINTS = [
  {
    method: 'post', path: '/auth/mobile/login', tag: 'Sign-in', auth: false, operationId: 'mobileLogin',
    summary: 'Sign in with email and password',
    description: 'Same lockout, sign-in-code and replay rules as the website. The refresh token comes back in the body, not a cookie.',
    body: req.mobileLogin,
    responses: { 200: { description: 'Signed in, or a sign-in code was sent', schema: res.LoginResponse }, 400: BAD, 401: err('Wrong email or password'), 429: LIMITED },
  },
  {
    method: 'post', path: '/auth/mobile/verify-otp', tag: 'Sign-in', auth: false, operationId: 'mobileVerifyOtp',
    summary: 'Answer a sign-in code challenge',
    body: req.mobileVerifyOtp,
    responses: { 200: { description: 'Signed in', schema: res.MobileSession }, 400: BAD, 401: err('The code is wrong or has expired'), 429: LIMITED },
  },
  {
    method: 'post', path: '/auth/mobile/refresh', tag: 'Sign-in', auth: false, operationId: 'mobileRefresh',
    summary: 'Trade a refresh token for a new access token and a new refresh token',
    description: 'The old refresh token stops working. Presenting an already-used one after the short grace period signs the phone out and alerts the owner.',
    body: req.refreshBody,
    responses: { 200: { description: 'New tokens', schema: res.MobileSession }, 400: BAD, 401: err('Unknown, used, expired or revoked refresh token') },
  },
  {
    method: 'post', path: '/auth/mobile/logout', tag: 'Sign-in', auth: false, operationId: 'mobileLogout',
    summary: 'Sign this phone out',
    description: 'Always succeeds, even for an unknown token.',
    body: req.refreshBody,
    responses: { 204: { description: 'Signed out', schema: null }, 400: BAD },
  },
  {
    method: 'get', path: '/app/version', tag: 'App', auth: false, operationId: 'getAppVersion',
    summary: 'Minimum and latest app version',
    description: 'Public: an app too old to sign in must still be able to read it. Pass your own version as ?current= to get updateRequired / updateAvailable.',
    query: [{ name: 'current', description: 'The version of the app asking, e.g. 1.2.0', schema: { type: 'string' } }],
    responses: { 200: { description: 'The release gate', schema: res.AppVersion } },
  },
  {
    method: 'get', path: '/home/attention', tag: 'Home', auth: true, operationId: 'getHomeAttention',
    summary: 'What is waiting on you',
    description: 'Routed by permission: you only see what you could act on, and never your own requests. Cached on the server for about 45 seconds.',
    responses: { 200: { description: 'Most urgent first, oldest first within a level; up to 50 items', schema: res.Attention }, 401: UNAUTH },
  },
  {
    method: 'get', path: '/home/summary', tag: 'Home', auth: true, operationId: 'getHomeSummary',
    summary: 'Today at a glance',
    description: 'Cached on the server for about 45 seconds.',
    responses: { 200: { description: 'Shop figures or just your own, by permission', schema: res.Summary }, 401: UNAUTH },
  },
  {
    method: 'post', path: '/devices', tag: 'Devices', auth: true, operationId: 'registerDevice',
    summary: 'Register this phone and its push token',
    description: 'Call after sign-in, whenever Firebase issues a new push token, and after an app update. Send pushToken: null to switch pushes off for this phone.',
    body: req.registerDevice,
    responses: { 200: { description: 'The phone as the server now has it', schema: z.looseObject({ device: res.Device }) }, 400: BAD, 401: UNAUTH, 403: err('Not a mobile sign-in (code MOBILE_ONLY)') },
  },
  {
    method: 'get', path: '/devices', tag: 'Devices', auth: true, operationId: 'listDevices',
    summary: 'Your signed-in phones (admins: everyone\'s with ?all=1)',
    query: [{ name: 'all', description: '1 = every phone in the business. Admin only', schema: { type: 'string', enum: ['1', 'true'] } }],
    responses: { 200: { description: 'Live phones, most recently seen first', schema: z.looseObject({ devices: z.array(res.Device) }) }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'delete', path: '/devices/{id}', tag: 'Devices', auth: true, operationId: 'revokeDevice',
    summary: 'Sign a phone out',
    description: 'Your own phone, or any phone for an admin. A revoked phone is refused on its very next request and its refresh tokens stop working.',
    pathParams: [{ name: 'id', description: 'The device id from the list', schema: { type: 'integer' } }],
    responses: { 200: { description: 'Revoked (or already was)', schema: res.RevokeResult }, 401: UNAUTH, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/approvals', tag: 'Approvals', auth: true, operationId: 'listApprovals',
    summary: 'Requests waiting on you (or already decided)',
    description: 'Voids, refunds, expenses, requisitions and large stock changes. You only see the kinds you may decide, never your own requests. Waiting items come oldest first, decided ones newest first.',
    query: [
      { name: 'status', description: 'pending (default), approved, rejected or closed (everything decided)', schema: { type: 'string', enum: ['pending', 'approved', 'rejected', 'closed'] } },
      { name: 'cursor', description: 'nextCursor from the previous page', schema: { type: 'string' } },
      { name: 'limit', description: '1 to 50, default 25', schema: { type: 'integer' } },
    ],
    responses: { 200: { description: 'One page', schema: res.ApprovalsPage }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'post', path: '/approvals/{id}/approve', tag: 'Approvals', auth: true, operationId: 'approveRequest',
    summary: 'Approve a request',
    description: 'Runs the void / refund / expense / requisition / stock change. Above the owner\'s amount (see settings.biometricApprovalAboveCents in the sign-in response) send biometricConfirmed: true after the fingerprint or face check, or the answer is 403 BIOMETRIC_REQUIRED. If someone decided first the answer is 200 with applied: false and their decision.',
    pathParams: [{ name: 'id', description: 'The request id, e.g. void:12', schema: { type: 'string' } }],
    body: req.approveBody,
    responses: { 200: { description: 'Decided (applied: true) or already decided by someone else (applied: false)', schema: res.ApprovalDecision }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('It can no longer be carried out (for example the sale is already voided)') },
  },
  {
    method: 'post', path: '/approvals/{id}/reject', tag: 'Approvals', auth: true, operationId: 'rejectRequest',
    summary: 'Reject a request',
    description: 'A reason is required; the person who asked is told it.',
    pathParams: [{ name: 'id', description: 'The request id, e.g. void:12', schema: { type: 'string' } }],
    body: req.rejectBody,
    responses: { 200: { description: 'Decided (applied: true) or already decided by someone else (applied: false)', schema: res.ApprovalDecision }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/notifications', tag: 'Alerts', auth: true, operationId: 'listNotifications',
    summary: 'Your alerts (the website\'s bell)',
    query: [{ name: 'cursor', description: 'nextCursor from the previous page', schema: { type: 'string' } }, { name: 'limit', description: '1 to 50, default 25', schema: { type: 'integer' } }],
    responses: { 200: { description: 'Newest first', schema: res.NotificationsPage }, 401: UNAUTH },
  },
  {
    method: 'get', path: '/stock/lookup', tag: 'Stock', auth: true, operationId: 'lookupStock',
    summary: 'Stock for a scanned barcode or a search',
    description: 'Pass barcode (exact barcode or SKU) or q (part of a name or SKU). Never includes cost. Needs inventory.adjust, stock.review or stock.receive.',
    query: [{ name: 'barcode', description: 'Scanned code', schema: { type: 'string' } }, { name: 'q', description: 'Search text', schema: { type: 'string' } }],
    responses: { 200: { description: 'Up to 20 products with stock by state', schema: res.StockLookup }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'post', path: '/stock/adjustments', tag: 'Stock', auth: true, operationId: 'adjustStock',
    summary: 'Change a product\'s stock with a reason',
    description: 'At or above the owner\'s unit limit (settings.stock_adjust_approval_units) a non-owner\'s change is NOT applied: it becomes a request for the owner (applied: false, approvalId). Needs inventory.adjust.',
    body: req.stockAdjustment,
    responses: { 200: { description: 'Applied, or sent for approval', schema: res.AdjustResult }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/orders', tag: 'Orders', auth: true, operationId: 'listOrders',
    summary: 'Orders, newest first',
    description: 'Read-only. Needs orders.view.',
    query: [
      { name: 'status', description: 'One order status', schema: { type: 'string' } },
      { name: 'courier', description: 'A courier name from the couriers list in the response', schema: { type: 'string' } },
      { name: 'unpaid', description: '1 = dispatched parcels not fully paid', schema: { type: 'string', enum: ['1', 'true'] } },
      { name: 'cursor', description: 'nextCursor from the previous page', schema: { type: 'string' } },
      { name: 'limit', description: '1 to 50, default 25', schema: { type: 'integer' } },
    ],
    responses: { 200: { description: 'One page, plus the couriers to filter by', schema: res.OrdersPage }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/orders/{id}', tag: 'Orders', auth: true, operationId: 'getOrder',
    summary: 'One order',
    pathParams: [{ name: 'id', description: 'The order id', schema: { type: 'integer' } }],
    responses: { 200: { description: 'The order with its lines and phone numbers', schema: res.OrderDetail }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/me/preferences', tag: 'App', auth: true, operationId: 'getPreferences',
    summary: 'Your app preferences',
    responses: { 200: { description: 'Quiet hours', schema: res.Preferences }, 401: UNAUTH },
  },
  {
    method: 'put', path: '/me/preferences', tag: 'App', auth: true, operationId: 'setPreferences',
    summary: 'Change your app preferences',
    description: 'Quiet hours hold back pushes on the shop\'s clock (the window may cross midnight). Urgent security alerts still come through; the alerts list always fills.',
    body: req.preferences,
    responses: { 200: { description: 'As saved', schema: res.Preferences }, 400: BAD, 401: UNAUTH },
  },
  {
    method: 'post', path: '/app/apk', tag: 'App', auth: true, operationId: 'uploadApk',
    summary: 'Upload a new app release (owner)',
    description: 'Raw request body is the .apk file (Content-Type: application/octet-stream), version in the query. It becomes the latest version. Needs app.manage.',
    query: [{ name: 'version', description: 'The release version, e.g. 1.1.0', schema: { type: 'string' } }],
    responses: { 200: { description: 'Stored', schema: res.ApkUpload }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 413: err('The file is too large') },
  },
  {
    method: 'get', path: '/app/apk', tag: 'App', auth: true, operationId: 'downloadApk',
    summary: 'Download the latest app (signed in)',
    responses: { 200: { description: 'The .apk file', schema: null }, 401: UNAUTH, 404: NOT_FOUND },
  },
  {
    method: 'post', path: '/app/download-links', tag: 'App', auth: true, operationId: 'makeDownloadLink',
    summary: 'Make a 7-day link to install the app on a new phone (owner)',
    description: 'Share the link, or show it as a QR code. Needs app.manage.',
    responses: { 200: { description: 'The link', schema: res.DownloadLink }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/app/download', tag: 'App', auth: false, operationId: 'downloadApkByLink',
    summary: 'Download the latest app with a signed link',
    query: [{ name: 't', description: 'The token in the link', schema: { type: 'string' } }],
    responses: { 200: { description: 'The .apk file', schema: null }, 401: err('The link is invalid or has expired (code LINK_EXPIRED)'), 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/openapi.json', tag: 'App', auth: false, operationId: 'getOpenApi',
    summary: 'This document',
    responses: { 200: { description: 'OpenAPI 3.1', schema: null } },
  },
];

// zod -> JSON Schema 2020-12, which is what OpenAPI 3.1 uses. `io` picks the input side for requests (defaults filled in
// by the server are optional for the caller) and the output side for responses.
function jsonSchema(schema, io) {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  delete out.$schema;
  return out;
}

function build() {
  const paths = {};
  for (const e of ENDPOINTS) {
    const parameters = [
      ...(e.pathParams || []).map((p) => ({ name: p.name, in: 'path', required: true, description: p.description, schema: p.schema })),
      ...(e.query || []).map((p) => ({ name: p.name, in: 'query', required: false, description: p.description, schema: p.schema })),
    ];
    const responses = {};
    for (const [status, r] of Object.entries(e.responses)) {
      responses[status] = r.schema
        ? { description: r.description, content: { 'application/json': { schema: jsonSchema(r.schema, 'output') } } }
        : { description: r.description };
    }
    paths[e.path] = {
      ...(paths[e.path] || {}),
      [e.method]: {
        operationId: e.operationId, tags: [e.tag], summary: e.summary, ...(e.description ? { description: e.description } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(e.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(e.body, 'input') } } } } : {}),
        security: e.auth ? [{ bearerAuth: [] }] : [],
        responses,
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Urban Trends POS - mobile API',
      version: '1.0.0',
      description: 'The API the Android app uses. Compatibility rule: fields and endpoints may be ADDED, but nothing is renamed or removed while an older app may still be installed; a breaking change goes to /api/v2. Clients must ignore fields they do not know.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [{ name: 'Sign-in' }, { name: 'Home' }, { name: 'Approvals' }, { name: 'Alerts' }, { name: 'Stock' }, { name: 'Orders' }, { name: 'Devices' }, { name: 'App' }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  };
}

module.exports = { ENDPOINTS, build };
