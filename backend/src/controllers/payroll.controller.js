const asyncHandler = require('../utils/asyncHandler');
const payrollService = require('../services/payroll.service');

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

module.exports = { getSummary, recordLossDeduction };
