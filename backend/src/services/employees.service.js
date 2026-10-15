const bcrypt = require('bcryptjs');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const settingsService = require('./settings.service');

const REQUIRED_DOC_TYPES = ['national_id', 'cv', 'contract'];
const VALID_ROLES = ['admin', 'manager', 'cashier'];

// §11 Employee Onboarding & Profile Activation: created inactive
// (is_active = 0) and 'pending_documents' — this is a DIFFERENT path from
// the plain POST /api/staff endpoint (users.service.js `create`), which
// stays fully unaffected and still creates an immediately-active account.
// Use this one specifically when you want the document/signature gate;
// use the other for a quick internal account.
function onboard({ storeId, staffId, name, email, phone, password, role }) {
  if (!name || !phone || !password || !role) throw new ApiError(400, 'name, phone, password, and role are required.');
  if (!VALID_ROLES.includes(role)) throw new ApiError(400, `role must be one of ${VALID_ROLES.join(', ')}.`);
  if (!email) throw new ApiError(400, 'email is required.');

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (store_id, name, email, phone, password_hash, role, is_active, onboarding_status)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'pending_documents')
  `).run(storeId, name, email.trim().toLowerCase(), phone, passwordHash, role);

  const user = db.prepare('SELECT id, name, email, phone, role, is_active, onboarding_status FROM users WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'staff', entityId: user.id, after: user });
  return user;
}

function getOnboardingStatus(employeeId) {
  const user = db.prepare('SELECT id, name, is_active, onboarding_status FROM users WHERE id = ?').get(employeeId);
  if (!user) throw new ApiError(404, 'Employee not found.');

  const docs = db.prepare('SELECT doc_type, uploaded_at FROM employee_documents WHERE staff_id = ?').all(employeeId);
  const docTypesPresent = docs.map((d) => d.doc_type);
  const missingDocs = REQUIRED_DOC_TYPES.filter((t) => !docTypesPresent.includes(t));

  const currentPolicyVersion = settingsService.getAll().employee_policy_version;
  const agreement = db.prepare(`
    SELECT * FROM employee_agreements WHERE staff_id = ? AND policy_version = ?
  `).get(employeeId, currentPolicyVersion);

  return { ...user, documents: docs, missingDocs, currentPolicyVersion, signedCurrentPolicy: !!agreement };
}

// Re-upload replaces — one row per (staff, doc_type), matches the unique
// index in schema.sql. No binary storage in this app — file_reference is
// wherever the actual file already lives (frontend uploads it elsewhere
// and hands this endpoint the resulting URL/path).
function uploadDocument({ employeeId, docType, fileReference, uploadedBy }) {
  if (!REQUIRED_DOC_TYPES.includes(docType)) throw new ApiError(400, `doc_type must be one of ${REQUIRED_DOC_TYPES.join(', ')}.`);
  if (!fileReference) throw new ApiError(400, 'file_reference is required.');

  const user = db.prepare('SELECT id, onboarding_status FROM users WHERE id = ?').get(employeeId);
  if (!user) throw new ApiError(404, 'Employee not found.');

  const txn = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM employee_documents WHERE staff_id = ? AND doc_type = ?').get(employeeId, docType);
    if (existing) {
      db.prepare(`UPDATE employee_documents SET file_reference = ?, uploaded_by = ?, uploaded_at = datetime('now') WHERE id = ?`)
        .run(fileReference, uploadedBy, existing.id);
    } else {
      db.prepare(`INSERT INTO employee_documents (staff_id, doc_type, file_reference, uploaded_by) VALUES (?, ?, ?, ?)`)
        .run(employeeId, docType, fileReference, uploadedBy);
    }

    // All three present and still at the first stage? Advance the gate —
    // matches "Profile remains Inactive until completed."
    if (user.onboarding_status === 'pending_documents') {
      const docTypesPresent = db.prepare('SELECT doc_type FROM employee_documents WHERE staff_id = ?').all(employeeId).map((d) => d.doc_type);
      if (REQUIRED_DOC_TYPES.every((t) => docTypesPresent.includes(t))) {
        db.prepare(`UPDATE users SET onboarding_status = 'pending_signature' WHERE id = ?`).run(employeeId);
      }
    }
  });
  txn();

  return getOnboardingStatus(employeeId);
}

// §13 Employee Agreement & E-Signature Module. NOTE: this is admin-
// witnessed, not employee self-service — a not-yet-activated account
// can't log in at all (is_active gates auth entirely in this app), so
// there's no portal for the employee to view the policy and sign it
// themselves before activation. A real deployment probably wants a
// lightweight unauthenticated onboarding-token flow for that; not built
// here. For now, whoever's running onboarding (the admin) captures the
// typed name as the signature on the employee's behalf.
function signAgreement({ employeeId, signedName, staffId }) {
  if (!signedName) throw new ApiError(400, 'signed_name is required.');
  const user = db.prepare('SELECT id, onboarding_status FROM users WHERE id = ?').get(employeeId);
  if (!user) throw new ApiError(404, 'Employee not found.');
  if (user.onboarding_status === 'active') throw new ApiError(409, 'This employee is already fully onboarded.');
  if (user.onboarding_status === 'pending_documents') {
    throw new ApiError(409, 'All required documents must be uploaded before the agreement can be signed.');
  }

  const policyVersion = settingsService.getAll().employee_policy_version;
  const existing = db.prepare('SELECT id FROM employee_agreements WHERE staff_id = ? AND policy_version = ?').get(employeeId, policyVersion);
  if (existing) throw new ApiError(409, `Already signed policy version ${policyVersion}.`);

  const txn = db.transaction(() => {
    db.prepare(`INSERT INTO employee_agreements (staff_id, policy_version, signed_name) VALUES (?, ?, ?)`)
      .run(employeeId, policyVersion, signedName);
    // Signing the current policy completes onboarding — flip both the
    // ceremony flag and the actual login gate together.
    db.prepare(`UPDATE users SET onboarding_status = 'active', is_active = 1 WHERE id = ?`).run(employeeId);

    logStaffAction({ staffId, action: 'update', entityType: 'staff', entityId: employeeId, before: { onboarding_status: user.onboarding_status }, after: { onboarding_status: 'active', is_active: 1 } });
  });
  txn();

  return getOnboardingStatus(employeeId);
}

module.exports = { REQUIRED_DOC_TYPES, onboard, getOnboardingStatus, uploadDocument, signAgreement };
