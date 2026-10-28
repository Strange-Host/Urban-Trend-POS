import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { handler } from '../http.js';
import { DEFAULT_PULL_DAYS, pullOrders, type PullCtx } from '../integrations/pullOrders.js';
import { audit } from '../pos/audit.js';

/** The Orders page's "Pull online orders": which stores can be pulled from, and pulling from one. */
export function onlineOrdersRouter(pool: Pool, ctx: Omit<PullCtx, 'pool'>): Router {
  const r = Router();
  r.use(requireAuth(pool));

  // Only what the button needs, never anything secret. A connection is listed once it has what it takes to call the store.
  r.get('/connections', requirePermission('orders.pull_online'), handler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.platform FROM income_sources s
        WHERE s.is_active AND s.import_orders AND (
          (s.platform = 'shopify' AND EXISTS (SELECT 1 FROM integration_secrets x WHERE x.provider = 'source:' || s.id AND x.name IN ('access_token', 'api_secret')))
       OR (s.platform = 'woocommerce' AND s.site_url IS NOT NULL AND EXISTS (SELECT 1 FROM integration_secrets x WHERE x.provider = 'source:' || s.id AND x.name = 'consumer_secret')))
        ORDER BY s.id`);
    res.json({ connections: rows.map((c) => ({ id: Number(c.id), name: c.name, platform: c.platform })) });
  }));

  r.post('/pull', requirePermission('orders.pull_online'), handler(async (req, res) => {
    const sourceId = Number(req.body?.sourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new HttpError(422, 'VALIDATION', 'Choose which connection to pull from.');
    const days = req.body?.days === undefined ? DEFAULT_PULL_DAYS : Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(422, 'VALIDATION', 'Days must be a whole number from 1 to 365.');
    const result = await pullOrders({ ...ctx, pool }, sourceId, { days });
    await audit(pool, { actor: req.user!.username, role: req.user!.role, action: 'online_orders_pulled', entityType: 'income_source', entityId: sourceId, details: { days, ...result, errors: undefined } });
    res.json(result);
  }));

  return r;
}
