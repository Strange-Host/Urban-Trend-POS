import { Router } from 'express';
import type { Logger } from '../logger.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { acknowledgeAlert, listAlerts } from '../alerts/alerts.js';
import { handler, idParam, paging, parse } from '../http.js';
import { z } from 'zod';
import { runNightlyIntegrity } from '../integrity/job.js';
import { trialBalance } from '../ledger/ledger.js';
import { discountsByStaff, riskyActions } from '../pos/reports.js';

export function reportsRouter(pool: Pool, opts: { logger: Logger }): Router {
  const r = Router();
  r.use(requireAuth(pool));
  const range = (q: Record<string, unknown>) => {
    const dt = (v: unknown) => { if (typeof v !== 'string' || !v) return undefined; const d = new Date(v); if (Number.isNaN(d.getTime())) throw new HttpError(422, 'VALIDATION', 'from and to must be dates (YYYY-MM-DD).'); return d; };
    return { from: dt(q.from), to: dt(q.to) };
  };

  r.get('/reports/discounts', requirePermission('reports.view'), handler(async (req, res) => { res.json({ rows: await discountsByStaff(pool, range(req.query)) }); }));
  r.get('/reports/risky-actions', requirePermission('reports.view'), handler(async (req, res) => { res.json({ rows: await riskyActions(pool, range(req.query)) }); }));
  r.get('/reports/trial-balance', requirePermission('reports.view'), handler(async (_req, res) => { res.json(await trialBalance(pool)); }));

  // The nightly integrity job's history, and a way to run it now.
  r.get('/integrity', requirePermission('audit.view'), handler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, ran_at, ok, jsonb_array_length(violations) AS violation_count, violations, counts FROM integrity_runs ORDER BY id DESC LIMIT 20`);
    res.json({ runs: rows.map((x) => ({ id: x.id, ranAt: x.ran_at, ok: x.ok, violationCount: x.violation_count, violations: x.violations, counts: x.counts })) });
  }));
  r.post('/integrity/run', requirePermission('policy.manage'), handler(async (_req, res) => {
    res.json(await runNightlyIntegrity(pool, { logger: opts.logger, force: true }));
  }));

  // Things a manager must look at. A failed nightly check raises one until someone acknowledges it.
  r.get('/alerts', requirePermission('atrisk.view'), handler(async (req, res) => { res.json(await listAlerts(pool, { openOnly: req.query.open === 'true', ...paging(req.query) })); }));
  r.post('/alerts/:id/acknowledge', requirePermission('atrisk.view'), handler(async (req, res) => {
    const b = parse(z.object({ note: z.string().max(500).optional() }), req.body);
    res.json({ alert: await acknowledgeAlert(pool, { id: idParam(req.params.id), note: b.note, actor: req.user!.username, role: req.user!.role }) });
  }));

  return r;
}
