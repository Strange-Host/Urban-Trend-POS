const asyncHandler = require('../utils/asyncHandler');
const payrollService = require('../services/payroll.service');
const runs = require('../services/payrollRuns.service');

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

// POST /api/payroll/runs  { from, to } — calculate the period and save it as a draft (replaces the period's existing draft)
const generateDraft = asyncHandler(async (req, res) => {
  const data = runs.generateDraft({ storeId: req.user.storeId, from: req.body.from, to: req.body.to, staffId: req.user.id });
  res.status(201).json({ data });
});

// POST /api/payroll/runs/:id/approve — locks the run
const approveRun = asyncHandler(async (req, res) => {
  res.json({ data: runs.approveRun({ runId: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id }) });
});

// POST /api/payroll/runs/:id/pay  { method: 'mpesa'|'bank'|'cash', payment_ref }
const payRun = asyncHandler(async (req, res) => {
  res.json({ data: runs.markRunPaid({
    runId: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id, method: req.body.method, paymentRef: req.body.payment_ref,
  }) });
});

module.exports = { getSummary, recordLossDeduction, listRuns, getRun, verifyRun, generateDraft, approveRun, payRun };
