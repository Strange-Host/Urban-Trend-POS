const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const approvals = require('../services/mobileApprovals.service');
const data = require('../services/mobileData.service');
const stockAdjust = require('../services/stockAdjust.service');
const release = require('../services/appRelease.service');
const settingsService = require('../services/settings.service');

// The mobile app's work endpoints (approvals, alerts, stock, orders, preferences, app downloads). Thin on purpose: validation
// is in routes/v1 (zod), the rules live in the services, and the permission check for each route is in routes/v1/index.js.

const pageSize = (q) => Math.min(50, Math.max(1, Number.parseInt(q.limit, 10) || 25));
const deviceOf = (req) => req.session?.device_name || null;

// GET /api/v1/approvals?status=pending|approved|rejected|closed&cursor=&limit=
const approvalsList = asyncHandler(async (req, res) => {
  res.json(approvals.list({ user: req.user, status: req.query.status || 'pending', cursor: req.query.cursor, limit: pageSize(req.query) }));
});

// POST /api/v1/approvals/:id/approve  { biometricConfirmed? }       POST .../reject  { reason }
const approve = asyncHandler(async (req, res) => {
  res.json(approvals.decide({ user: req.user, session: req.session, rawId: req.params.id, decision: 'approve', biometricConfirmed: req.body.biometricConfirmed }));
});
const reject = asyncHandler(async (req, res) => {
  res.json(approvals.decide({ user: req.user, session: req.session, rawId: req.params.id, decision: 'reject', note: req.body.reason }));
});

// GET /api/v1/notifications?cursor=&limit=  - the same rows as the website's bell (yours only)
const notifications = asyncHandler(async (req, res) => {
  res.json(data.notificationsList({ userId: req.user.id, cursor: req.query.cursor, limit: pageSize(req.query) }));
});

// GET /api/v1/stock/lookup?barcode=  or  ?q=
const stockLookup = asyncHandler(async (req, res) => {
  res.json({ items: data.stockLookup({ storeId: req.user.storeId, barcode: req.query.barcode, q: req.query.q }) });
});

// POST /api/v1/stock/adjustments  { productId, delta, reason, note? }
const stockAdjustment = asyncHandler(async (req, res) => {
  const { productId, delta, reason, note } = req.body;
  res.json(stockAdjust.adjustFromApp({ user: req.user, productId, delta, reason, note, device: deviceOf(req) }));
});

// GET /api/v1/orders?status=&courier=&unpaid=1&cursor=   and   GET /api/v1/orders/:id
const orders = asyncHandler(async (req, res) => {
  res.json(data.ordersList({
    storeId: req.user.storeId, status: req.query.status, courier: req.query.courier,
    unpaid: req.query.unpaid === '1' || req.query.unpaid === 'true', cursor: req.query.cursor, limit: pageSize(req.query),
  }));
});
const order = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(404, 'Order not found.');
  res.json(data.orderDetail({ storeId: req.user.storeId, id }));
});

// GET / PUT /api/v1/me/preferences  { quietHours: { enabled, start, end } }
const getPreferences = asyncHandler(async (req, res) => { res.json(data.getPreferences(req.user.id)); });
const putPreferences = asyncHandler(async (req, res) => {
  res.json(data.setPreferences({ userId: req.user.id, quietHours: req.body.quietHours, device: deviceOf(req) }));
});

// POST /api/v1/app/apk?version=1.2.0   (raw body = the .apk)     - owner: upload a release
const uploadApk = asyncHandler(async (req, res) => {
  res.json(await release.saveUpload({ req, version: String(req.query.version || ''), userId: req.user.id }));
});
// GET /api/v1/app/apk   - any signed-in person: the latest app (the app updating itself)
const downloadApk = asyncHandler(async (req, res) => sendApk(res));
// POST /api/v1/app/download-links   - owner: a 7-day link for a new phone's browser (share it, or turn it into a QR code)
const makeLink = asyncHandler(async (req, res) => {
  res.json(release.makeLink({ origin: `${req.protocol}://${req.get('host')}`, userId: req.user.id }));
});
// GET /api/v1/app/download?t=<token>   - the link above
const downloadByLink = asyncHandler(async (req, res) => { release.verifyLink(req.query.t); sendApk(res); });

function sendApk(res) {
  const latest = release.latestFile();
  if (!latest) throw new ApiError(404, 'No app file has been uploaded yet.');
  res.set('Cache-Control', 'private, no-store');
  res.type('application/vnd.android.package-archive');
  res.download(latest.path, `urbantrends-${latest.version}.apk`);
}

// What the app must obey, attached to sign-in and refresh responses.
function appSettings() {
  const s = settingsService.getAll();
  const kes = Number(s.approval_biometric_above_kes);
  const lock = Number.parseInt(s.app_auto_lock_seconds, 10);
  return {
    autoLockSeconds: Number.isInteger(lock) && lock >= 15 ? lock : 120,
    biometricApprovalAboveCents: Number.isFinite(kes) && kes > 0 ? Math.round(kes * 100) : null,
  };
}

module.exports = {
  approvalsList, approve, reject, notifications, stockLookup, stockAdjustment, orders, order,
  getPreferences, putPreferences, uploadApk, downloadApk, makeLink, downloadByLink, appSettings,
};
