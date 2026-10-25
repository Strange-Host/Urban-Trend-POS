import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { handler, idParam, parse } from '../http.js';
import { attendanceFor, clockIn, clockOut, markAbsent } from '../payroll/attendance.js';
import { addCommissionPlan, adjustmentsFor, profilesOnPayroll, recordAdjustment, setPayProfile } from '../payroll/profiles.js';
import { exportRunCsv, payslip, renderPayslip, salaryTable, staffBreakdown } from '../payroll/reports.js';
import { approveRun, generateDraft, getRun, listRuns, markRunPaid } from '../payroll/runs.js';
import { shopDate } from '../payroll/time.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const generateBody = z.object({ from: date, to: date });
const cents = z.number().int().min(0);
const planBody = z.object({ name: z.string().min(1).max(100), targetCents: z.number().int().positive(), rateBelow70Cents: cents, rate70Cents: cents, rate80Cents: cents });
const profileBody = z.object({
  staffKey: z.string().min(1).max(64), effectiveFrom: date, dailyRetainerCents: cents, commissionPlanId: z.number().int().positive().optional(),
  workdayStartMinute: z.number().int().min(0).max(1439).optional(), expectedMinutes: z.number().int().min(0).max(1440).optional(),
  lateFeePerHourCents: cents.optional(), absenceFeeCents: cents.optional(), missingHourFeeCents: cents.optional(),
});
const adjustmentBody = z.object({ staffKey: z.string().min(1).max(64), type: z.enum(['salary_advance', 'loss_deduction', 'bonus']), amountCents: z.number().int().positive(), effectiveDate: date, reason: z.string().min(1).max(300) });
const absenceBody = z.object({ staffKey: z.string().min(1).max(64), workDate: date, reason: z.string().min(1).max(300) });
const period = z.object({ from: date, to: date }).refine((p) => p.to >= p.from, 'The end cannot be before the start.');
const payBody = z.object({ method: z.enum(['mpesa', 'bank', 'cash']), paymentRef: z.string().max(100).optional() });

// Viewing follows payroll.view (manager and admin). Generating a draft is payroll.manage. APPROVING and PAYING are admin only.
// The actor recorded on every run is the logged-in user: it is never taken from the request.
export function payrollRouter(pool: Pool): Router {
  const r = Router();
  r.use(requireAuth(pool));

  r.get('/runs', requirePermission('payroll.view'), handler(async (_req, res) => { res.json({ runs: await listRuns(pool) }); }));

  r.get('/runs/:id', requirePermission('payroll.view'), handler(async (req, res) => {
    const run = await getRun(pool, idParam(req.params.id));
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
    res.json({ run });
  }));

  r.post('/runs', requirePermission('payroll.manage'), handler(async (req, res) => {
    const b = parse(generateBody, req.body);
    res.status(201).json({ run: await generateDraft({ pool }, { ...b, actor: req.user!.username }) });
  }));

  r.post('/runs/:id/approve', requirePermission('payroll.approve'), handler(async (req, res) => {
    res.json({ run: await approveRun({ pool }, { runId: idParam(req.params.id), actor: req.user!.username }) });
  }));

  r.post('/runs/:id/pay', requirePermission('payroll.pay'), handler(async (req, res) => {
    const b = parse(payBody, req.body);
    res.json({ run: await markRunPaid({ pool }, { runId: idParam(req.params.id), ...b, actor: req.user!.username }) });
  }));

  // ---------------------------------------------------------------- pay rates: admin only
  r.get('/plans', requirePermission('payroll.view'), handler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, name, target_cents, rate_below_70_cents, rate_70_cents, rate_80_cents, created_by, created_at FROM commission_plans ORDER BY id DESC`);
    res.json({ plans: rows.map((p) => ({ id: p.id, name: p.name, targetCents: p.target_cents, rateBelow70Cents: p.rate_below_70_cents, rate70Cents: p.rate_70_cents, rate80Cents: p.rate_80_cents, createdBy: p.created_by })) });
  }));
  r.post('/plans', requirePermission('payroll.rates'), handler(async (req, res) => {
    res.status(201).json({ plan: await addCommissionPlan(pool, { ...parse(planBody, req.body), actor: req.user!.username }) });
  }));
  r.get('/profiles', requirePermission('payroll.view'), handler(async (req, res) => {
    const asOf = typeof req.query.asOf === 'string' ? parse(date, req.query.asOf) : shopDate(new Date());
    res.json({ asOf, profiles: await profilesOnPayroll(pool, asOf) });
  }));
  r.post('/profiles', requirePermission('payroll.rates'), handler(async (req, res) => {
    res.status(201).json({ profile: await setPayProfile(pool, { ...parse(profileBody, req.body), actor: req.user!.username }) });
  }));

  // ---------------------------------------------------------------- adjustments (advances, loss deductions, bonuses)
  r.get('/adjustments', requirePermission('payroll.view'), handler(async (req, res) => {
    const q = parse(z.object({ staffKey: z.string().min(1).max(64), from: date, to: date }), req.query);
    res.json({ adjustments: await adjustmentsFor(pool, q.staffKey, q.from, q.to) });
  }));
  r.post('/adjustments', requirePermission('payroll.manage'), handler(async (req, res) => {
    res.status(201).json({ adjustment: await recordAdjustment(pool, { ...parse(adjustmentBody, req.body), actor: req.user!.username }) });
  }));

  // ---------------------------------------------------------------- attendance
  r.post('/attendance/clock-in', requirePermission('attendance.own'), handler(async (req, res) => {
    res.status(201).json({ record: await clockIn(pool, { staffKey: req.user!.username }) });
  }));
  r.post('/attendance/clock-out', requirePermission('attendance.own'), handler(async (req, res) => {
    res.json({ record: await clockOut(pool, { staffKey: req.user!.username }) });
  }));
  r.post('/attendance/absences', requirePermission('attendance.manage'), handler(async (req, res) => {
    res.status(201).json({ record: await markAbsent(pool, { ...parse(absenceBody, req.body), actor: req.user!.username }) });
  }));
  // Anyone can see their own attendance; seeing someone else's needs attendance.manage.
  r.get('/attendance', requirePermission('attendance.own'), handler(async (req, res) => {
    const q = parse(z.object({ staffKey: z.string().max(64).optional(), from: date, to: date }), req.query);
    const key = q.staffKey ?? req.user!.username;
    if (key !== req.user!.username && !can(req.user!.role, 'attendance.manage')) throw new HttpError(403, 'FORBIDDEN', 'You can only see your own attendance.');
    res.json({ staffKey: key, records: await attendanceFor(pool, key, q.from, q.to) });
  }));

  // ---------------------------------------------------------------- the salary pages
  r.get('/salary', requirePermission('payroll.view'), handler(async (req, res) => {
    res.json(await salaryTable(pool, parse(period, req.query)));
  }));
  // One person's breakdown: managers see anyone's; everyone else sees only their own.
  r.get('/staff/:key', requirePermission('attendance.own'), handler(async (req, res) => {
    const key = String(req.params.key);
    if (key !== req.user!.username && !can(req.user!.role, 'payroll.view')) throw new HttpError(403, 'FORBIDDEN', 'You can only see your own pay.');
    res.json(await staffBreakdown(pool, key, parse(period, req.query)));
  }));
  r.get('/runs/:id/payslips/:key', requirePermission('attendance.own'), handler(async (req, res) => {
    const key = String(req.params.key);
    if (key !== req.user!.username && !can(req.user!.role, 'payroll.view')) throw new HttpError(403, 'FORBIDDEN', 'You can only see your own payslip.');
    const slip = await payslip(pool, idParam(req.params.id), key);
    if (req.query.format === 'text') { res.type('text/plain').send(renderPayslip(slip)); return; }
    res.json({ payslip: slip });
  }));
  r.get('/runs/:id/export.csv', requirePermission('payroll.view'), handler(async (req, res) => {
    res.type('text/csv').set('Content-Disposition', `attachment; filename="payroll-run-${idParam(req.params.id)}.csv"`).send(await exportRunCsv(pool, idParam(req.params.id)));
  }));

  return r;
}
