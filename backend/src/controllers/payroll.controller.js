const asyncHandler = require('../utils/asyncHandler');
const payrollService = require('../services/payroll.service');
const runs = require('../services/payrollRuns.service');
const payTerms = require('../services/payTerms.service');

// GET /api/payroll/summary?staff_id=&from=&to=
const getSummary = asyncHandler(async (req, res) => {
  const summary = payrollService.getSummary({
    staffId: req.query.staff_id, storeId: req.user.storeId,
    periodStart: req.query.from, periodEnd: req.query.to,
  });
  res.json({ data: summary });
});

// POST /api/payroll/loss-deduction  { staff_id, amount, notes }
const recordLossDeduction = asyncHandler(async (req, res) => {
  const { staff_id, amount, notes } = req.body;
  const adjustment = payrollService.recordLossDeduction({
    staffId: staff_id, storeId: req.user.storeId, amount, notes, createdBy: req.user.id,
  });
  res.status(201).json({ data: adjustment });
});

// Locked payroll runs (Rule 9). Approve and pay are admin-only (routes).
// GET /api/payroll/runs
const listRuns = asyncHandler(async (req, res) => {
  res.json({ data: runs.listRuns({ storeId: req.user.storeId }) });
});

// GET /api/payroll/runs/:id
const getRun = asyncHandler(async (req, res) => {
  res.json({ data: runs.getRun({ runId: Number(req.params.id), storeId: req.user.storeId }) });
});

// GET /api/payroll/runs/:id/verify — re-hash a locked run against the fingerprint recorded at approval
const verifyRun = asyncHandler(async (req, res) => {
  res.json({ data: runs.verifyRun({ runId: Number(req.params.id), storeId: req.user.storeId }) });
});

// POST /api/payroll/runs  { month: 'YYYY-MM' } or { from, to } (inside one month) — calculate the period and save it as a
// draft (replaces the period's existing draft)
const generateDraft = asyncHandler(async (req, res) => {
  const data = runs.generateDraft({ storeId: req.user.storeId, month: req.body.month, from: req.body.from, to: req.body.to, staffId: req.user.id });
  res.status(201).json({ data });
});

// POST /api/payroll/runs/:id/approve — locks the run
const approveRun = asyncHandler(async (req, res) => {
  res.json({ data: runs.approveRun({ runId: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id }) });
});

// POST /api/payroll/runs/:id/pay  { method: 'mpesa'|'bank'|'cash', payment_ref, signed_name, checksum } — the payout sign-off
const payRun = asyncHandler(async (req, res) => {
  res.json({ data: runs.markRunPaid({
    runId: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id, method: req.body.method, paymentRef: req.body.payment_ref,
    signedName: req.body.signed_name, checksum: req.body.checksum,
  }) });
});

// GET /api/payroll/cycle — the month being worked, the month just finished, and the fixed pay date
const cycle = asyncHandler(async (req, res) => {
  res.json({ data: runs.cycleStatus({ storeId: req.user.storeId }) });
});

// Pay terms per employee (fixed / percentage / combined). Admin only (routes).
// GET /api/payroll/pay-terms
const listPayTerms = asyncHandler(async (req, res) => {
  res.json({ data: payTerms.listTerms({ storeId: req.user.storeId }) });
});

// PUT /api/payroll/pay-terms/:staffId  { type, fixed_cents, percent_bp }
const setPayTerms = asyncHandler(async (req, res) => {
  const data = payTerms.setTerms({
    staffId: Number(req.params.staffId), storeId: req.user.storeId, actorId: req.user.id,
    type: req.body.type, fixedCents: req.body.fixed_cents, percentBp: req.body.percent_bp,
  });
  res.json({ data });
});

module.exports = { getSummary, recordLossDeduction, listRuns, getRun, verifyRun, generateDraft, approveRun, payRun, cycle, listPayTerms, setPayTerms };
