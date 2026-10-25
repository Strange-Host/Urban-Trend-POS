import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { handler, idParam, paging, parse } from '../http.js';
import { addLeadMessage, assignLead, convertLead, createLead, getLead, LEAD_SOURCES, listLeads, setLeadStatus, updateLead, type LeadStatus } from '../leads/leads.js';

const channel = z.enum(['whatsapp', 'sms', 'call', 'website', 'internal']);
const createBody = z.object({
  name: z.string().max(150).optional(), phone: z.string().min(1).max(30), source: z.enum(LEAD_SOURCES).optional(), productInterest: z.string().max(300).optional(),
  notes: z.string().max(1000).optional(), message: z.string().max(2000).optional(), channel: channel.optional(),
});
const updateBody = z.object({ name: z.string().max(150).nullable().optional(), productInterest: z.string().max(300).nullable().optional(), notes: z.string().max(1000).nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');
const statusBody = z.object({ status: z.enum(['new', 'contacted', 'qualified', 'lost']), lostReason: z.string().max(300).optional() });
const assignBody = z.object({ assignedTo: z.string().max(64).nullable() });
const messageBody = z.object({ direction: z.enum(['inbound', 'outbound', 'note']), channel: channel.optional(), body: z.string().min(1).max(2000) });
const convertBody = z.object({
  items: z.array(z.object({ sku: z.string().max(40).optional(), name: z.string().min(1).max(200), quantity: z.number().int().min(1), unitPriceCents: z.number().int().min(0), discountCents: z.number().int().min(0).optional() })).min(1),
  customerName: z.string().max(150).optional(), discountCents: z.number().int().min(0).optional(), notes: z.string().max(500).optional(), assignedTo: z.string().max(64).optional(),
});

export function leadsRouter(pool: Pool, opts: { orderRefKey?: string }): Router {
  const r = Router();
  const who = (req: Express.Request) => ({ actor: req.user!.username, role: req.user!.role });
  r.use(requireAuth(pool));

  r.get('/', requirePermission('leads.view'), handler(async (req, res) => {
    const q = req.query;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    res.json(await listLeads(pool, { status: str(q.status) as LeadStatus | 'open' | undefined, assignedTo: str(q.assignedTo), unassigned: q.unassigned === 'true', source: str(q.source), search: str(q.search), ...paging(q) }));
  }));

  r.get('/:id', requirePermission('leads.view'), handler(async (req, res) => {
    const l = await getLead(pool, idParam(req.params.id));
    if (!l) throw new HttpError(404, 'LEAD_NOT_FOUND', 'Lead not found.');
    res.json({ lead: l });
  }));

  r.post('/', requirePermission('leads.manage'), handler(async (req, res) => {
    const out = await createLead(pool, { ...parse(createBody, req.body), ...who(req) });
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  r.patch('/:id', requirePermission('leads.manage'), handler(async (req, res) => {
    res.json({ lead: await updateLead(pool, { id: idParam(req.params.id), ...parse(updateBody, req.body), actor: req.user!.username }) });
  }));

  r.put('/:id/status', requirePermission('leads.manage'), handler(async (req, res) => {
    res.json({ lead: await setLeadStatus(pool, { id: idParam(req.params.id), ...parse(statusBody, req.body), ...who(req) }) });
  }));

  r.put('/:id/assignee', requirePermission('leads.assign'), handler(async (req, res) => {
    res.json({ lead: await assignLead(pool, { id: idParam(req.params.id), ...parse(assignBody, req.body), ...who(req) }) });
  }));

  r.post('/:id/messages', requirePermission('leads.manage'), handler(async (req, res) => {
    res.status(201).json({ lead: await addLeadMessage(pool, { id: idParam(req.params.id), ...parse(messageBody, req.body), actor: req.user!.username }) });
  }));

  // Convert to order: creates the order and closes the lead in one transaction.
  r.post('/:id/convert', requirePermission('orders.create'), handler(async (req, res) => {
    if (!opts.orderRefKey) throw new HttpError(503, 'ORDER_REF_KEY_MISSING', 'Order references are not configured on this server (ORDER_REF_KEY).');
    const out = await convertLead(pool, opts.orderRefKey, { id: idParam(req.params.id), ...parse(convertBody, req.body), ...who(req) });
    res.status(201).json(out);
  }));

  return r;
}
