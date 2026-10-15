const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const leadsService = require('./leads.service');
const notificationsService = require('./notifications.service');
const { getOrCreateSystemUser } = require('./paymentReconciliation.service');
const { normalizePhone } = require('../utils/phone');
const { logStaffAction } = require('../utils/auditLog');

// Leads arriving from web forms (WordPress/WPForms and similar), ported from the
// older system's POST /api/v1/leads — but authenticated (a shared secret, see
// routes/leadIntake.routes.js), idempotent on the form's own entry id, never
// silently dropping a repeat customer, and routed by an editable table instead
// of "form name must equal product name".

function pick(fields, ...names) {
  const lower = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.toLowerCase().trim(), v]));
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function startsWithKey(fields, prefix) {
  const key = Object.keys(fields).find((k) => k.toLowerCase().startsWith(prefix.toLowerCase()));
  return key ? String(fields[key]).trim() || null : null;
}

// WPForms labels are free text and differ per form, so variants (colour, size…)
// are matched by keyword — the same approach the older system used.
function pickVariants(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (/colou?r|size|material|variant/i.test(k) && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

/**
 * Accepts either the WPForms webhook shape
 *   { formId, formName, wpEntryId, fields: { "Name": "...", "Phone Number": "...", ... } }
 * or a flat shape { name, phone, email, notes, location, form_name, entry_id }.
 */
function parsePayload(body) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'Expected a JSON body.');

  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  const src = fields || body;

  const first = pick(src, 'First', 'First Name');
  const last = pick(src, 'Last', 'Last Name');
  const name = pick(src, 'Name', 'Full Name', 'name') || [first, last].filter(Boolean).join(' ') || null;
  const phone = pick(src, 'Phone Number', 'Phone', 'Mobile', 'phone');
  const altPhone = pick(src, 'Alternative Phone Number', 'Alternative Phone', 'Alt Phone');
  const email = pick(src, 'Email', 'Email Address', 'email');
  const location = pick(src, 'Location', 'Delivery County', 'County', 'City', 'Town', 'location');
  const info = startsWithKey(src, 'Additional information') || pick(src, 'Notes', 'Message', 'Enquiry', 'notes', 'message');
  const variants = pickVariants(src);
  const importNote = pick(src, 'Import Note');   // used by the one-off import of old records; shown on its own line

  const formName = (body.formName || body.form_name || '').toString().trim() || null;
  const formId = body.formId ?? body.form_id ?? null;
  const entryRaw = body.wpEntryId ?? body.entry_id ?? body.external_id ?? null;
  const externalId = entryRaw !== null && String(entryRaw).trim() !== '' ? `${formId ?? 'form'}-${String(entryRaw).trim()}` : null;

  const requestedSource = String(body.source || '').toLowerCase();
  const source = requestedSource === 'shopify' ? 'shopify' : 'other';

  return { name, phone, altPhone, email, location, info, variants, importNote, formName, formId, externalId, source, raw: body };
}

function routeFor(storeId, formName) {
  if (!formName) return null;
  return db.prepare(`
    SELECT r.*, p.name AS product_name FROM lead_form_routes r LEFT JOIN products p ON p.id = r.product_id
    WHERE r.store_id = ? AND lower(r.form_name) = lower(?) AND r.is_active = 1
  `).get(storeId, formName.trim());
}

function buildNotes(parsed, productName) {
  const lines = [];
  if (parsed.formName) lines.push(`Web form: ${parsed.formName}`);
  if (productName) lines.push(`Interested in: ${productName}`);
  if (parsed.location) lines.push(`Location: ${parsed.location}`);
  if (parsed.altPhone) lines.push(`Alternative phone: ${parsed.altPhone}`);
  for (const [k, v] of Object.entries(parsed.variants)) lines.push(`${k}: ${v}`);
  if (parsed.info) lines.push(`Customer said: ${parsed.info}`);
  if (parsed.importNote) lines.push(parsed.importNote);
  return lines.join('\n') || null;
}

/**
 * Returns { outcome: 'created' | 'replay' | 'existing_lead', leadId }.
 *  - replay: this exact form entry was already imported (webhook retry) — no-op.
 *  - existing_lead: the phone already has a lead — nothing new is created (the
 *    system never duplicates a lead), but the repeat enquiry is added to that
 *    lead's timeline and its owner is told, so a returning customer isn't ignored.
 */
function intake({ storeId, body }) {
  const parsed = parsePayload(body);
  const digits = String(parsed.phone || '').replace(/\D/g, '');
  if (digits.length < 7) {
    logger.warn(`[lead-intake] rejected a "${parsed.formName || 'unnamed'}" submission: no usable phone number`);
    throw new ApiError(400, 'A phone number is required.');
  }

  if (parsed.externalId) {
    const seen = db.prepare('SELECT id FROM leads WHERE store_id = ? AND source = ? AND external_id = ?').get(storeId, parsed.source, parsed.externalId);
    if (seen) return { outcome: 'replay', leadId: seen.id };
  }

  const system = getOrCreateSystemUser(storeId);
  const route = routeFor(storeId, parsed.formName);
  const productName = route?.product_name || null;
  const notes = buildNotes(parsed, productName);

  // A route may pin the lead to a specific active rep; otherwise normal
  // equal-distribution applies inside leadsService.create.
  let assignedStaffId;
  if (route?.assigned_staff_id) {
    const rep = db.prepare('SELECT id FROM users WHERE id = ? AND store_id = ? AND is_active = 1').get(route.assigned_staff_id, storeId);
    if (rep) assignedStaffId = rep.id;
  }

  let lead;
  try {
    lead = leadsService.create({
      storeId, staffId: system.id, name: parsed.name || 'Website lead', phone: parsed.phone, email: parsed.email,
      source: parsed.source, notes, assignedStaffId,
    });
  } catch (err) {
    if (err.statusCode === 409 && err.details?.existingLeadId) return handleRepeat({ storeId, existingLeadId: err.details.existingLeadId, parsed, productName, notes, systemId: system.id });
    throw err;
  }

  db.prepare(`UPDATE leads SET external_id = ?, form_name = ?, raw_payload = ?, interested_product_id = ? WHERE id = ?`)
    .run(parsed.externalId, parsed.formName, JSON.stringify(parsed.raw).slice(0, 20000), route?.product_id || null, lead.id);
  return { outcome: 'created', leadId: lead.id };
}

function handleRepeat({ storeId, existingLeadId, parsed, productName, notes, systemId }) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(existingLeadId);
  db.prepare(`INSERT INTO lead_activities (lead_id, type, content, staff_id) VALUES (?, 'note', ?, ?)`)
    .run(existingLeadId, `Submitted a web form again.\n${notes || ''}`.trim(), systemId);
  logStaffAction({ staffId: systemId, action: 'update', entityType: 'lead', entityId: existingLeadId, before: {}, after: { repeat_web_enquiry: parsed.formName || true } });
  if (lead.assigned_staff_id) {
    notificationsService.notify({
      storeId, userIds: [lead.assigned_staff_id], type: 'lead_resubmitted', severity: 'info',
      title: `${lead.name} enquired again${productName ? ` about ${productName}` : ''}`, body: `${lead.phone} — see the lead's notes`,
      entityType: 'lead', entityId: existingLeadId,
    });
  }
  return { outcome: 'existing_lead', leadId: existingLeadId };
}

// ------------------------------------------------------------ routing admin

function listRoutes(storeId) {
  return db.prepare(`
    SELECT r.*, p.name AS product_name, u.name AS staff_name FROM lead_form_routes r
    LEFT JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = r.assigned_staff_id
    WHERE r.store_id = ? ORDER BY lower(r.form_name)
  `).all(storeId);
}

function validateTargets(storeId, productId, staffId) {
  // products carry no store_id in this schema (they are catalogue-wide), so existence is the only check available
  if (productId && !db.prepare('SELECT id FROM products WHERE id = ? AND is_active = 1').get(productId)) throw new ApiError(404, 'Product not found.');
  if (staffId && !db.prepare(`SELECT id FROM users WHERE id = ? AND store_id = ? AND is_active = 1`).get(staffId, storeId)) throw new ApiError(404, 'Staff member not found.');
}

function createRoute({ storeId, staffId, formName, productId, assignedStaffId }) {
  validateTargets(storeId, productId, assignedStaffId);
  try {
    const r = db.prepare(`INSERT INTO lead_form_routes (store_id, form_name, product_id, assigned_staff_id) VALUES (?, ?, ?, ?)`)
      .run(storeId, formName.trim(), productId || null, assignedStaffId || null);
    logStaffAction({ staffId, action: 'create', entityType: 'lead_form_route', entityId: r.lastInsertRowid, after: { formName, productId, assignedStaffId } });
    return listRoutes(storeId).find((x) => x.id === r.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new ApiError(409, 'A route for that form name already exists.');
    throw err;
  }
}

function updateRoute({ storeId, staffId, id, formName, productId, assignedStaffId, isActive }) {
  const existing = db.prepare('SELECT * FROM lead_form_routes WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) throw new ApiError(404, 'Route not found.');
  const nextProduct = productId === undefined ? existing.product_id : productId;
  const nextStaff = assignedStaffId === undefined ? existing.assigned_staff_id : assignedStaffId;
  validateTargets(storeId, nextProduct, nextStaff);
  try {
    db.prepare(`UPDATE lead_form_routes SET form_name = ?, product_id = ?, assigned_staff_id = ?, is_active = ? WHERE id = ?`)
      .run(formName ? formName.trim() : existing.form_name, nextProduct || null, nextStaff || null, isActive === undefined ? existing.is_active : (isActive ? 1 : 0), id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new ApiError(409, 'A route for that form name already exists.');
    throw err;
  }
  logStaffAction({ staffId, action: 'update', entityType: 'lead_form_route', entityId: id, before: existing, after: { formName, productId, assignedStaffId, isActive } });
  return listRoutes(storeId).find((x) => x.id === id);
}

function removeRoute({ storeId, staffId, id }) {
  const existing = db.prepare('SELECT * FROM lead_form_routes WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) throw new ApiError(404, 'Route not found.');
  db.prepare('DELETE FROM lead_form_routes WHERE id = ?').run(id);
  logStaffAction({ staffId, action: 'delete', entityType: 'lead_form_route', entityId: id, before: existing });
  return { id };
}

module.exports = { intake, parsePayload, listRoutes, createRoute, updateRoute, removeRoute };
