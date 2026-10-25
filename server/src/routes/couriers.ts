import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { addOrganization, addRider, courierProfile, listCouriers, setCourierActive } from '../couriers/couriers.js';
import { listCosts, listOpenCollections } from '../couriers/lists.js';
import { organizationStanding, recordOrgCollection, createStatement } from '../couriers/organizations.js';
import { approveCourierCost, createPayout, recordCourierCost, rejectCourierCost, unpaidItems } from '../couriers/payables.js';
import type { Pool } from '../db/pool.js';
import { dateStr, handler, idParam, paging, parse } from '../http.js';

const cents = z.number().int().min(0);
const riderBody = z.object({ name: z.string().min(1).max(100), phone: z.string().max(30).optional(), idNumber: z.string().max(30).optional(), vehiclePlate: z.string().max(20).optional() });
const orgBody = z.object({
  name: z.string().min(1).max(100), contactPerson: z.string().max(100).optional(), phone: z.string().max(30).optional(), agentNames: z.array(z.string().max(100)).max(50).optional(),
  collectsPayment: z.boolean(), overdueLimitCents: cents.optional(), overdueAfterDays: z.number().int().min(1).max(365).optional(),
});
const costBody = z.object({
  kind: z.enum(['return_trip', 'fuel', 'airtime', 'handling', 'repair', 'other']), amountCents: z.number().int().positive(), description: z.string().min(1).max(300),
  orderRef: z.string().max(30).optional(), receiptRef: z.string().max(100).optional(),
});
const rejectBody = z.object({ reason: z.string().min(1).max(300) });
const payoutBody = z.object({
  method: z.enum(['mpesa', 'bank', 'cash']), paymentRef: z.string().max(100).optional(),
  items: z.array(z.object({ type: z.enum(['package_fee', 'courier_cost']), id: z.number().int().positive() })).optional(),
});
const collectionBody = z.object({ orderRef: z.string().min(1).max(30), amountCents: z.number().int().positive(), collectedOn: dateStr.optional() });
const statementBody = z.object({
  periodStart: dateStr, periodEnd: dateStr, collectionIds: z.array(z.number().int().positive()).min(1), chargeEnteredCents: cents, remittedCents: cents, remittanceRef: z.string().max(100).optional(),
});

export function couriersRouter(pool: Pool): Router {
  const r = Router();
  r.use(requireAuth(pool));
  const me = (req: Express.Request) => req.user!.username;

  r.get('/couriers', requirePermission('couriers.view'), handler(async (req, res) => {
    const kind = req.query.kind === 'rider' || req.query.kind === 'organization' ? req.query.kind : undefined;
    res.json({ couriers: await listCouriers(pool, { kind, activeOnly: req.query.active === 'true' }) });
  }));
  r.post('/couriers/riders', requirePermission('couriers.manage'), handler(async (req, res) => {
    res.status(201).json({ courier: await addRider(pool, { ...parse(riderBody, req.body), actor: me(req) }) });
  }));
  r.post('/couriers/organizations', requirePermission('couriers.manage'), handler(async (req, res) => {
    res.status(201).json({ courier: await addOrganization(pool, { ...parse(orgBody, req.body), actor: me(req) }) });
  }));
  r.put('/couriers/:id/active', requirePermission('couriers.manage'), handler(async (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    res.json({ courier: await setCourierActive(pool, { courierId: idParam(req.params.id), active }) });
  }));

  // costs queue (before :id routes so "costs" is not read as an id)
  r.get('/couriers/costs', requirePermission('couriers.view'), handler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const courierId = req.query.courierId === undefined ? undefined : idParam(req.query.courierId);
    res.json(await listCosts(pool, { status, courierId, ...paging(req.query) }));
  }));
  r.post('/couriers/costs/:id/approve', requirePermission('courier_costs.approve'), handler(async (req, res) => {
    res.json({ cost: await approveCourierCost({ pool }, { costId: idParam(req.params.id), actor: me(req) }) });
  }));
  r.post('/couriers/costs/:id/reject', requirePermission('courier_costs.approve'), handler(async (req, res) => {
    res.json({ cost: await rejectCourierCost({ pool }, { costId: idParam(req.params.id), ...parse(rejectBody, req.body), actor: me(req) }) });
  }));

  r.get('/couriers/:id', requirePermission('couriers.view'), handler(async (req, res) => {
    const id = idParam(req.params.id);
    const profile = await courierProfile(pool, id);
    const standing = profile.courier.kind === 'organization' && profile.courier.collectsPayment ? await organizationStanding(pool, id) : null;
    res.json({ profile, standing });
  }));
  r.get('/couriers/:id/unpaid', requirePermission('couriers.view'), handler(async (req, res) => { res.json({ items: await unpaidItems(pool, idParam(req.params.id)) }); }));
  r.get('/couriers/:id/open-collections', requirePermission('couriers.view'), handler(async (req, res) => { res.json({ collections: await listOpenCollections(pool, idParam(req.params.id)) }); }));

  r.post('/couriers/:id/costs', requirePermission('couriers.manage'), handler(async (req, res) => {
    res.status(201).json({ cost: await recordCourierCost({ pool }, { courierId: idParam(req.params.id), ...parse(costBody, req.body), actor: me(req) }) });
  }));
  // Paying a courier is money leaving the business: admin only.
  r.post('/couriers/:id/payouts', requirePermission('courier_payouts.pay'), handler(async (req, res) => {
    res.status(201).json({ payout: await createPayout({ pool }, { courierId: idParam(req.params.id), ...parse(payoutBody, req.body), actor: me(req) }) });
  }));
  r.post('/couriers/:id/collections', requirePermission('couriers.manage'), handler(async (req, res) => {
    res.status(201).json({ collection: await recordOrgCollection({ pool }, { courierId: idParam(req.params.id), ...parse(collectionBody, req.body), actor: me(req) }) });
  }));
  r.post('/couriers/:id/statements', requirePermission('couriers.manage'), handler(async (req, res) => {
    res.status(201).json({ statement: await createStatement({ pool }, { courierId: idParam(req.params.id), ...parse(statementBody, req.body), actor: me(req) }) });
  }));

  return r;
}
