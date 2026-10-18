const app = require('./app');
const logger = require('./utils/logger');
const validateEnv = require('./utils/validateEnv');
const db = require('./config/db');
const { scheduleBackups } = require('./services/backup.service');
const { findDrift } = require('./services/reconciliation.service');
const { expireUnconfirmedOrders } = require('./services/orders.service');
const { rebalanceStaleAssignments } = require('./services/telesalesDistribution.service');
const settingsService = require('./services/settings.service');
const alerting = require('./services/alerting.service');
const smsService = require('./services/sms.service');
const notificationsService = require('./services/notifications.service');
const liveSync = require('./services/liveSync.service');

validateEnv();

const PORT = process.env.PORT || 4000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

// 0.3 — without these, an error that isn't caught anywhere else (a bug in
// a background job, a rejected promise nobody awaited) crashes the whole
// process with no chance to log context first. This doesn't make the
// error not-a-bug — it still needs fixing — but it's the difference
// between "logged and the process kept serving other requests" and
// "gone, with only whatever the OS captured on the way down." Exiting
// after an uncaughtException (rather than trying to keep running) is
// deliberate: Node's own docs are explicit that the process is in an
// unknown state at that point, and a process supervisor (pm2/systemd —
// see ecosystem.config.js / urban-trends-pos.service) restarting it
// cleanly is safer than limping on.
process.on('uncaughtException', (err) => {
  logger.error('[fatal] uncaught exception — restarting', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('[fatal] unhandled promise rejection — restarting', { error: err.message, stack: err.stack });
  process.exit(1);
});

require('./services/securityBaseline.service').clearDefaultAdminPins();

app.listen(PORT, () => {
  logger.info(`Urban Trends POS API listening on port ${PORT}`);
  scheduleBackups();

  // COD Confirmation Gate (§1): unconfirmed COD orders auto-cancel once
  // their window elapses. dispatch()/confirmCod() already catch this
  // lazily on their own (an expired order can't slip through either
  // path), but a customer who never touches the order again would
  // otherwise sit in `awaiting_dispatch` forever with nothing to trigger
  // the check — this sweep is what actually closes those out.
  //
  // 0.2 — every setInterval body below is wrapped in try/catch: an
  // uncaught throw inside a timer callback isn't something Express's
  // error handling ever sees (it's not part of any request), so without
  // this a transient error here (a busy DB, a bad row) would otherwise
  // hit the uncaughtException handler above and take the whole server
  // down over what should just be "try again in 15 minutes."
  const codExpiryCheck = setInterval(() => {
    try {
      const expiredIds = expireUnconfirmedOrders();
      if (expiredIds.length > 0) {
        logger.info(`[orders] auto-cancelled ${expiredIds.length} unconfirmed COD order(s) past their confirmation window`, { orderIds: expiredIds });
      }
    } catch (err) {
      logger.error('[orders] COD expiry sweep failed', { error: err.message, stack: err.stack });
    }
  }, FIFTEEN_MINUTES_MS);
  codExpiryCheck.unref?.();

  // §3 10:00 AM Rule + §11 Unplanned Absences: same sweep handles both —
  // see telesalesDistribution.service.js's rebalanceStaleAssignments for
  // why they're one mechanism. Runs per store since eligibility/workload
  // are all store-scoped.
  const telesalesRebalanceCheck = setInterval(() => {
    try {
      const cutoffHour = parseInt(settingsService.getAll().telesales_cutoff_hour, 10) || 10;
      const stores = db.prepare('SELECT id FROM stores').all();
      for (const store of stores) {
        const moved = rebalanceStaleAssignments({ storeId: store.id, cutoffHour });
        const movedCount = moved.leads.length + moved.orders.length;
        if (movedCount > 0) {
          logger.info(`[telesales] reassigned ${movedCount} stale/unassigned lead(s)/order(s) for store ${store.id}`, moved);
        }
      }
    } catch (err) {
      logger.error('[telesales] rebalance sweep failed', { error: err.message, stack: err.stack });
    }
  }, FIFTEEN_MINUTES_MS);
  telesalesRebalanceCheck.unref?.();

  // Customer SMS outbox: business events only INSERT a 'queued' row (inside
  // their own transaction); this is the sender. Retries with backoff and
  // expires anything stale — see sms.service.js. Async, so a slow Zettatel
  // can't block the event loop; processOutbox() guards against overlapping runs.
  const smsOutboxDrain = setInterval(() => {
    smsService.processOutbox().catch((err) => {
      logger.error('[sms] outbox drain failed', { error: err.message, stack: err.stack });
    });
  }, 30 * 1000);
  smsOutboxDrain.unref?.();

  // In-app notifications that aren't tied to a single request: leads whose
  // follow-up date has arrived, products at their reorder level, and pruning.
  // Run once shortly after boot so a restart doesn't delay them 15 minutes.
  const runNotificationSweeps = () => {
    try {
      const r = notificationsService.runSweeps();
      if (r.followUps || r.lowStock) logger.info('[notifications] sweep created notices', r);
    } catch (err) {
      logger.error('[notifications] sweep failed', { error: err.message, stack: err.stack });
    }
  };
  setTimeout(runNotificationSweeps, 20 * 1000).unref?.();
  const notificationSweep = setInterval(runNotificationSweeps, FIFTEEN_MINUTES_MS);
  notificationSweep.unref?.();

  // Live sync safety net: every minute, ask each connected store "what changed since I last looked?"
  // (only stores whose own interval - Settings > Income sources - has elapsed actually do any work).
  // Webhooks are the fast path; this catches anything they missed. Overlap-guarded and error-isolated.
  const liveSyncPoll = setInterval(() => {
    liveSync.pollTick().catch((err) => logger.error('[live-sync] poll failed', { error: err.message, stack: err.stack }));
  }, 60 * 1000);
  liveSyncPoll.unref?.();

  // Detect-only, not auto-fix — see reconciliation.service.js for why an
  // automatic fix isn't run here. This just makes sure drift shows up in
  // the logs (and from there, whatever alerting is watching them) instead
  // of silently sitting there until someone happens to check Settings.
  const reconciliationCheck = setInterval(() => {
    try {
      const drift = findDrift();
      if (drift.length > 0) {
        logger.warn(`[reconcile] ${drift.length} inventory row(s) have drifted from the ledger — check Settings or GET /api/inventory/reconcile`, { rows: drift });
        alerting.alertInventoryDrift(drift); // 2.4 — same reasoning as the backup alerts above
      } else {
        alerting.resolveNotices('inventory_drift'); // clean now: the next drift may notify again
      }
    } catch (err) {
      logger.error('[reconcile] drift check failed', { error: err.message, stack: err.stack });
    }
  }, TWENTY_FOUR_HOURS_MS);
  reconciliationCheck.unref?.();
});
