import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { createCustomer, findCustomerByPhone, getCustomer, listCustomers, setPrepay, updateCustomer } from '../customers/customers.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { flag, handler, idParam, paging, parse } from '../http.js';

const text = z.string().max(300);
const createBody = z.object({ name: z.string().min(1).max(150), phone: z.string().min(1).max(30), altPhone: text.optional(), town: text.optional(), address: text.optional(), notes: text.optional() });
const updateBody = z.object({ name: z.string().min(1).max(150).optional(), altPhone: text.nullable().optional(), town: text.nullable().optional(), address: text.nullable().optional(), notes: text.nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');
const prepayBody = z.object({ required: z.boolean(), reason: z.string().max(300).optional() });

export function customersRouter(pool: Pool): Router {
  const r = Router();
  const who = (req: Express.Request) => ({ actor: req.user!.username, role: req.user!.role });
  r.use(requireAuth(pool));

  r.get('/', requirePermission('customers.view'), handler(async (req, res) => {
    res.json(await listCustomers(pool, { search: typeof req.query.search === 'string' ? req.query.search : undefined, prepayOnly: flag(req.query.prepay) === true, ...paging(req.query) }));
  }));

  // Look a customer up by whatever phone format was typed: used before creating an order to see their history.
  r.get('/lookup', requirePermission('customers.view'), handler(async (req, res) => {
    const phone = typeof req.query.phone === 'string' ? req.query.phone : '';
    res.json({ customer: await findCustomerByPhone(pool, phone) });
  }));

  r.get('/:id', requirePermission('customers.view'), handler(async (req, res) => {
    const c = await getCustomer(pool, idParam(req.params.id));
    if (!c) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
    res.json({ customer: c });
  }));

  r.post('/', requirePermission('customers.manage'), handler(async (req, res) => {
    res.status(201).json({ customer: await createCustomer(pool, { ...parse(createBody, req.body), ...who(req) }) });
  }));

  r.patch('/:id', requirePermission('customers.manage'), handler(async (req, res) => {
    res.json({ customer: await updateCustomer(pool, { id: idParam(req.params.id), ...parse(updateBody, req.body), ...who(req) }) });
  }));

  r.put('/:id/prepay', requirePermission('customers.flag'), handler(async (req, res) => {
    res.json({ customer: await setPrepay(pool, { id: idParam(req.params.id), ...parse(prepayBody, req.body), ...who(req) }) });
  }));

  return r;
}
