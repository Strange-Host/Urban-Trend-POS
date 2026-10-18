const db = require('../config/db');
const logger = require('../utils/logger');
const notifications = require('./notifications.service');
const alerting = require('./alerting.service');
const settingsService = require('./settings.service');

// One place that records anything security-relevant and tells the admins about it.
//  - every event is kept in security_events (the Security page lists the latest ones)
//  - admins see it in the notification bell (everyone except the person who did it)
//  - 'urgent' ones are also emailed, when email is set up (same recipients as the backup alerts)
// Never throws: an alert problem must not break the action that triggered it.

const kes = (cents) => `KES ${(Number(cents || 0) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const limits = () => {
  const s = settingsService.getAll();
  return {
    refundCents: Math.round(num(s.security_alert_refund_kes, 3000) * 100),
    stockUnits: num(s.security_alert_stock_units, 25),
    pricePercent: num(s.security_alert_price_percent, 15),
  };
};

function raise({ storeId = null, type, severity = 'info', title, detail = null, actorId = null, subjectId = null, ip = null, notify = true }) {
  try {
    const id = db.prepare(`
      INSERT INTO security_events (store_id, type, severity, title, detail, actor_id, subject_id, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, type, severity, title, detail, actorId, subjectId, ip).lastInsertRowid;

    if (notify) {
      const rows = storeId
        ? db.prepare(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1 AND store_id = ?`).all(storeId)
        : db.prepare(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1`).all();
      const userIds = rows.map((r) => r.id).filter((uid) => uid !== actorId);
      if (userIds.length) {
        notifications.notify({
          storeId: storeId || db.prepare('SELECT store_id FROM users WHERE id = ?').get(userIds[0])?.store_id,
          userIds, type: 'security', title, body: detail, severity, entityType: 'security_event', entityId: id,
        });
      }
    }
    if (severity === 'urgent') {
      alerting.sendAlert({ subject: title, message: detail || title }).catch(() => {});
    }
    return id;
  } catch (err) {
    logger.error('[security] could not record event', { type, error: err.message });
    return null;
  }
}

const ago = (m) => `${m} minute${m === 1 ? '' : 's'}`;

function accountLocked({ user, channel, minutes, attempts, ip }) {
  return raise({
    storeId: user.store_id, type: 'account_locked', severity: 'urgent', subjectId: user.id, ip,
    title: `${user.name}'s ${channel === 'pin' ? 'PIN sign-in' : 'account'} was locked`,
    detail: `${attempts} wrong ${channel === 'pin' ? 'PINs' : 'passwords'} in a row. It is locked for ${ago(minutes)}.${ip ? ` Attempts came from ${ip}.` : ''} If this was not ${user.name}, consider changing their password.`,
  });
}
function refreshReuse({ user, ip }) {
  return raise({
    storeId: user.store_id, type: 'session_reuse', severity: 'urgent', subjectId: user.id, ip,
    title: `A sign-in for ${user.name} was used twice`,
    detail: `A saved sign-in was replayed after it had already been used. That can mean a copied browser session, so every device signed in as ${user.name} was signed out.`,
  });
}
function largeMoney({ storeId, actor, kind, amountCents, reference }) {
  if (amountCents < limits().refundCents) return null;
  return raise({
    storeId, type: kind === 'void' ? 'large_void' : 'large_refund', severity: 'warning', actorId: actor.id,
    title: `${kind === 'void' ? 'Sale voided' : 'Refund'} of ${kes(amountCents)} by ${actor.name}`,
    detail: `${kind === 'void' ? 'Voided sale' : 'Refunded payment'} ${reference || ''} for ${kes(amountCents)}.`.replace('  ', ' '),
  });
}
function priceChanged({ storeId, actor, product, oldCents, newCents }) {
  if (!oldCents || oldCents === newCents) return null;
  const pct = Math.abs(newCents - oldCents) / oldCents * 100;
  if (pct < limits().pricePercent) return null;
  return raise({
    storeId, type: 'price_changed', severity: newCents < oldCents ? 'warning' : 'info', actorId: actor.id,
    title: `${product} price ${newCents < oldCents ? 'lowered' : 'raised'} by ${actor.name}`,
    detail: `${kes(oldCents)} to ${kes(newCents)} (${pct.toFixed(0)}% ${newCents < oldCents ? 'lower' : 'higher'}).`,
  });
}
function stockAdjusted({ storeId, actor, product, qty, reason }) {
  if (Math.abs(qty) < limits().stockUnits) return null;
  return raise({
    storeId, type: 'stock_adjusted', severity: qty < 0 ? 'warning' : 'info', actorId: actor.id,
    title: `Stock ${qty < 0 ? 'reduced' : 'increased'} by ${Math.abs(qty)} by ${actor.name}`,
    detail: `${product || 'A product'}: ${qty > 0 ? '+' : ''}${qty} units (${reason || 'adjustment'}).`,
  });
}
const STAFF_TITLES = {
  created: (s) => `New staff account: ${s}`,
  role_changed: (s) => `${s}'s role was changed`,
  password_reset: (s) => `${s}'s password was reset`,
  deactivated: (s) => `${s}'s account was deactivated`,
  reactivated: (s) => `${s}'s account was reactivated`,
  deleted: (s) => `${s}'s account was permanently deleted`,
  erased: (s) => `${s}'s personal data was erased`,
  permissions_changed: (s) => `${s}'s permissions were changed`,
  two_factor_changed: (s) => `Sign-in code setting changed for ${s}`,
  signed_out_everywhere: (s) => `${s} was signed out of every device`,
};
function staffEvent({ storeId, actor, kind, subjectName, subjectId = null, detail = null }) {
  const urgent = ['deleted', 'erased', 'role_changed'].includes(kind);
  return raise({
    storeId, type: `staff_${kind}`, severity: urgent ? 'warning' : 'info', actorId: actor.id, subjectId,
    title: `${STAFF_TITLES[kind](subjectName)}${kind === 'created' ? '' : ` by ${actor.name}`}`, detail,
  });
}
function credentialsChanged({ storeId, actor, what }) {
  return raise({
    storeId, type: 'credentials_changed', severity: 'warning', actorId: actor.id,
    title: `${what} changed by ${actor.name}`,
    detail: 'Connection details or settings used to reach an outside service were saved. If this was not expected, review the account.',
  });
}

module.exports = { raise, accountLocked, refreshReuse, largeMoney, priceChanged, stockAdjusted, staffEvent, credentialsChanged, limits, kes };
