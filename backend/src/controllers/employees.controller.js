const asyncHandler = require('../utils/asyncHandler');
const employeesService = require('../services/employees.service');

// POST /api/employees/onboard  { name, email, phone, password, role }
const onboard = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role } = req.body;
  const employee = employeesService.onboard({ storeId: req.user.storeId, staffId: req.user.id, name, email, phone, password, role });
  res.status(201).json({ data: employee });
});

// GET /api/employees/:id/onboarding-status
const getOnboardingStatus = asyncHandler(async (req, res) => {
  res.json({ data: employeesService.getOnboardingStatus(req.params.id) });
});

// POST /api/employees/:id/documents  { doc_type, file_reference }
const uploadDocument = asyncHandler(async (req, res) => {
  const { doc_type, file_reference } = req.body;
  const status = employeesService.uploadDocument({
    employeeId: req.params.id, docType: doc_type, fileReference: file_reference, uploadedBy: req.user.id,
  });
  res.status(201).json({ data: status });
});

// POST /api/employees/:id/sign-agreement  { signed_name }
const signAgreement = asyncHandler(async (req, res) => {
  const status = employeesService.signAgreement({ employeeId: req.params.id, signedName: req.body.signed_name, staffId: req.user.id });
  res.json({ data: status });
});

module.exports = { onboard, getOnboardingStatus, uploadDocument, signAgreement };
