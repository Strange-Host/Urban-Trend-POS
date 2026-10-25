import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { createProduct, getProduct, listProducts, updateProduct } from '../catalog/products.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { flag, handler, idParam, paging, parse } from '../http.js';
import { adjustStock, isStrict, listMovements, receiveStock, setStrict, writeOffStock } from '../stock/stock.js';

const money = z.number().int().min(0);
const createBody = z.object({
  sku: z.string().min(1).max(40), name: z.string().min(1).max(200), category: z.string().max(100).optional(),
  priceCents: money, costCents: money.optional(), trackStock: z.boolean().optional(), reorderLevel: z.number().int().min(0).optional(),
});
const updateBody = z.object({
  name: z.string().min(1).max(200).optional(), category: z.string().max(100).nullable().optional(), priceCents: money.optional(), costCents: money.optional(),
  trackStock: z.boolean().optional(), reorderLevel: z.number().int().min(0).optional(), active: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to change.');
const receiveBody = z.object({ quantity: z.number().int(), unitCostCents: money.optional(), note: z.string().max(300).optional() });
const adjustBody = z.object({ delta: z.number().int(), reason: z.string().min(1).max(300) });
const writeOffBody = z.object({ quantity: z.number().int(), reason: z.string().min(1).max(300) });

export function catalogRouter(pool: Pool): Router {
  const r = Router();
  const who = (req: Express.Request) => ({ actor: req.user!.username, role: req.user!.role });
  r.use(['/products', '/stock'], requireAuth(pool));

  r.get('/products', requirePermission('catalog.view'), handler(async (req, res) => {
    const q = req.query;
    res.json(await listProducts(pool, {
      search: typeof q.search === 'string' ? q.search : undefined, category: typeof q.category === 'string' ? q.category : undefined,
      active: flag(q.active), lowOnly: flag(q.low) === true, ...paging(q),
    }));
  }));

  r.get('/products/:id', requirePermission('catalog.view'), handler(async (req, res) => {
    const p = await getProduct(pool, idParam(req.params.id));
    if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    res.json({ product: p });
  }));

  r.post('/products', requirePermission('catalog.manage'), handler(async (req, res) => {
    res.status(201).json({ product: await createProduct(pool, { ...parse(createBody, req.body), ...who(req) }) });
  }));

  r.patch('/products/:id', requirePermission('catalog.manage'), handler(async (req, res) => {
    res.json({ product: await updateProduct(pool, { id: idParam(req.params.id), ...parse(updateBody, req.body), ...who(req) }) });
  }));

  // ---- stock
  r.get('/stock/movements', requirePermission('stock.view'), handler(async (req, res) => {
    const pid = req.query.productId === undefined ? undefined : idParam(req.query.productId);
    res.json(await listMovements(pool, { productId: pid, ...paging(req.query) }));
  }));

  r.post('/products/:id/receive', requirePermission('stock.receive'), handler(async (req, res) => {
    res.status(201).json(await receiveStock(pool, { productId: idParam(req.params.id), ...parse(receiveBody, req.body), ...who(req) }));
  }));

  r.post('/products/:id/adjust', requirePermission('stock.adjust'), handler(async (req, res) => {
    res.status(201).json(await adjustStock(pool, { productId: idParam(req.params.id), ...parse(adjustBody, req.body), ...who(req) }));
  }));

  r.post('/products/:id/write-off', requirePermission('stock.adjust'), handler(async (req, res) => {
    res.status(201).json(await writeOffStock(pool, { productId: idParam(req.params.id), ...parse(writeOffBody, req.body), ...who(req) }));
  }));

  // ---- strict mode: every line must name a catalogued product. Switch on before cutover.
  r.get('/stock/strict', requirePermission('stock.view'), handler(async (_req, res) => { res.json({ strict: await isStrict(pool) }); }));
  r.put('/stock/strict', requirePermission('policy.manage'), handler(async (req, res) => {
    const { strict } = parse(z.object({ strict: z.boolean() }), req.body);
    await setStrict(pool, { strict, ...who(req) });
    res.json({ strict });
  }));

  return r;
}
