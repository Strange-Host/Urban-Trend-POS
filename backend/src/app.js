require('./config/env'); // loads backend/.env and creates any missing secrets — must stay first
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { buildCorsOptions } = require('./config/cors');
const systemConfig = require('./services/systemConfig.service');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const logger = require('./utils/logger');
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('./config/limits');

const errorHandler = require('./middleware/errorHandler');

const requireModule = require('./middleware/requireModule');
const modulesRoutes = require('./routes/modules.routes');
const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/products.routes');
const categoryRoutes = require('./routes/categories.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const salesRoutes = require('./routes/sales.routes');
const reportsRoutes = require('./routes/reports.routes');
const usersRoutes = require('./routes/users.routes');
const shopifyRoutes = require('./routes/shopify.routes');
const leadsRoutes = require('./routes/leads.routes');
const requisitionsRoutes = require('./routes/requisitions.routes');
const expensesRoutes = require('./routes/expenses.routes');
const pettyCashRoutes = require('./routes/pettyCash.routes');
const paymentsRoutes = require('./routes/payments.routes');
const staffLogsRoutes = require('./routes/staffLogs.routes');
const settingsRoutes = require('./routes/settings.routes');
const paymentGatewayCredentialsRoutes = require('./routes/paymentGatewayCredentials.routes');
const incomeSourcesRoutes = require('./routes/incomeSources.routes');
const backupsRoutes = require('./routes/backups.routes');
const cashSessionsRoutes = require('./routes/cashSessions.routes');
const ordersRoutes = require('./routes/orders.routes');
const custodyRoutes = require('./routes/custody.routes');
const paymentReconciliationRoutes = require('./routes/paymentReconciliation.routes');
const paymentWebhooksRoutes = require('./routes/paymentWebhooks.routes');
const paymentCallbacksRoutes = require('./routes/paymentCallbacks.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const telesalesRoutes = require('./routes/telesales.routes');
const payrollRoutes = require('./routes/payroll.routes');
const employeesRoutes = require('./routes/employees.routes');
const smsRoutes = require('./routes/sms.routes');
const systemRoutes = require('./routes/system.routes');
const webhooksRoutes = require('./routes/webhooks.routes');
const couriersRoutes = require('./routes/couriers.routes');
const shiftRoutes = require('./routes/shift.routes');
const leadIntakeRoutes = require('./routes/leadIntake.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();

// Railway (like any host) puts a proxy in front of this app. Trust exactly one hop so req.ip - which the
// rate limiters and the lockout alerts use - is the real visitor address instead of the proxy's. Set TRUST_PROXY_HOPS=2
// in Railway if you put Cloudflare in front (two proxies sit between the visitor and this app).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);   // 1 = Railway only; 2 = Cloudflare in front of Railway

app.use(helmet());

// Cross-origin policy lives in config/cors.js: with CORS_ORIGIN unset, this
// machine and the shop's own network are allowed (no setup needed); set
// CORS_ORIGIN to lock it to specific origins, e.g. when the frontend is hosted
// on a public domain. Production behaves the same way - there is no longer a
// required-setting trap.
app.use(cors(buildCorsOptions({
  configured: () => systemConfig.allowedOrigins(),
  onBlocked: (origin) => logger.warn(
    `Blocked a browser request from ${origin}, which is not on this network. If that is your frontend, add it under Settings > Server & public address (Allowed website addresses).`,
  ),
})));

app.use(compression());
// Webhook deliveries are signed over their exact bytes, so keep the raw body for those routes - and only
// those. They also get a bigger body limit (a store sends whole orders/products) and a form parser for
// WooCommerce's unsigned "ping". Everything else keeps the tight 1 MB JSON limit.
app.use('/api/integrations/webhooks', express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
// Provider callbacks (M-Pesa/KCB) carry their shared secret IN THE URL PATH
// (/callbacks/<provider>/<secret>/...). Logging originalUrl verbatim would
// write that secret to the console and app.log on every delivery, so the
// secret segment is masked before anything is logged.
function redactCallbackSecret(url) {
  return String(url).replace(/(\/callbacks\/(?:mpesa|c2b|kcb)\/)[^/?]+/i, '$1[redacted]');
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const safeUrl = redactCallbackSecret(req.originalUrl);
    logger.info(`${req.method} ${safeUrl} ${res.statusCode}`, {
      method: req.method, path: safeUrl, status: res.statusCode,
      durationMs: Date.now() - start, userId: req.user?.id,
    });
  });
  next();
});

// Baseline limit for the whole API — the specific limiters below (auth,
// checkout, sync) are tighter and target abuse patterns unique to those
// endpoints; this catches everything else, which previously had no limit
// at all. Generous enough that normal use (POS + dashboard + reports)
// never comes close — this is a DoS/scripted-abuse backstop, not a
// per-user throttle.
const generalApiLimiter = rateLimit({ ...RATE_LIMITS.GENERAL_API, standardHeaders: true });
app.use('/api', generalApiLimiter);

app.use('/api/auth', authRoutes);

app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/staff', usersRoutes); // Staff module (§5) — same controller, reuses `users`
app.use('/api/integrations/shopify', shopifyRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/requisitions', requireModule('hr'), requisitionsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/petty-cash', pettyCashRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/staff-logs', staffLogsRoutes);
app.use('/api/modules', modulesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/security', require('./routes/security.routes'));
app.use('/api/settings/payment-gateways', paymentGatewayCredentialsRoutes);
app.use('/api/income-sources', incomeSourcesRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/cash-sessions', cashSessionsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/custody', custodyRoutes);
app.use('/api/payment-reconciliation', paymentReconciliationRoutes);
app.use('/api/integrations/payments', paymentWebhooksRoutes);
// Raw provider callbacks — Safaricom/KCB's actual payload shapes, auth'd
// by a secret embedded in the URL path rather than a header (see
// middleware/webhookPathAuth.js). Deliberately separate from the
// normalized /webhook routes above, which stay in place for manual/internal testing.
app.use('/api/integrations/payments/callbacks', paymentCallbacksRoutes);
app.use('/api/attendance', requireModule('hr'), attendanceRoutes);
app.use('/api/telesales', telesalesRoutes);
app.use('/api/payroll', requireModule('hr'), payrollRoutes);
app.use('/api/employees', requireModule('hr'), employeesRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/integrations/webhooks', webhooksRoutes);
app.use('/api/couriers', couriersRoutes);
app.use('/api/shift', shiftRoutes);
app.use('/api/integrations/leads', leadIntakeRoutes);
app.use('/api/notifications', notificationsRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Serve the built website (frontend/dist) from this same server, so the site and the API share ONE address.
// That is what makes the SameSite=Strict login cookie work with no CORS or proxy tricks. Skipped when the
// frontend hasn't been built (local development uses the Vite dev server instead).
const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
const FRONTEND_INDEX = path.join(FRONTEND_DIST, 'index.html');
if (fs.existsSync(FRONTEND_INDEX)) {
  app.use(express.static(FRONTEND_DIST, {
    index: false,
    setHeaders: (res, filePath) => {
      // Vite fingerprints everything under /assets, so those files can be cached for a year.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  // Any non-API address without a file extension (/login, /products...) is a page inside the React app: hand back
  // index.html. A missing file such as /assets/old.js falls through to a real 404 instead.
  app.get(/^\/(?!api(\/|$)|assets\/)(?!.*\.[A-Za-z0-9]+$).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(FRONTEND_INDEX);
  });
}

app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));
app.use(errorHandler);

module.exports = app;
