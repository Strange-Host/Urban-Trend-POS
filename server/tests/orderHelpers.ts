import { runMigrations } from '../src/db/migrate.js';
import { addOrganization, addRider } from '../src/couriers/couriers.js';
import { createOrder, dispatchOrder, type CreateOrderInput, type OrderCtx } from '../src/orders/orders.js';
import { makeTestDb, type TestDb } from './helpers.js';

export const KEY = 'test-key-for-order-refs-0123456789abcdef';

export interface Env { db: TestDb; ctx: OrderCtx }

export async function makeEnv(): Promise<Env> {
  const db = await makeTestDb();
  await runMigrations(db.pool);
  return { db, ctx: { pool: db.pool, refKey: KEY } };
}

let phone = 0;
/** A phone number never used before in this process, so tests do not trip the one-active-order-per-phone rule. */
export const freshPhone = () => `07${String(10_000_000 + phone++)}`;

export function newOrder(env: Env, over: Partial<CreateOrderInput> = {}) {
  return createOrder(env.ctx, {
    customerName: 'Wanjiku Test',
    customerPhone: freshPhone(),
    items: [{ name: 'Sneakers', quantity: 1, unitPriceCents: 500_000 }],
    actor: 'agent-1',
    ...over,
  });
}

const riders = new WeakMap<Env, number>();

/** A rider for tests that just need someone to dispatch with. One per environment. */
export async function defaultRider(env: Env): Promise<number> {
  let id = riders.get(env);
  if (id === undefined) {
    id = (await addRider(env.db.pool, { name: 'Test Rider', phone: '0700000000', actor: 'admin' })).id;
    riders.set(env, id);
  }
  return id;
}

/** Dispatches an order with the default rider and a KES 300 package fee, unless told otherwise. */
export async function dispatch(env: Env, orderRef: string, actor = 'dispatcher', over: { courierId?: number; feeCents?: number; zeroReason?: string } = {}) {
  return dispatchOrder(env.ctx, {
    orderRef, actor, courierId: over.courierId ?? (await defaultRider(env)),
    packageFee: { amountCents: over.feeCents ?? 30_000, zeroReason: over.zeroReason },
  });
}

let orgN = 0;
/** An organization courier for tests. */
export async function newOrg(env: Env, over: Partial<Parameters<typeof addOrganization>[1]> = {}) {
  return addOrganization(env.db.pool, { name: `Test Org ${orgN++}`, contactPerson: 'Contact', phone: '0711000000', collectsPayment: true, actor: 'admin', ...over });
}
let riderN = 0;
export async function newRider(env: Env, over: Partial<Parameters<typeof addRider>[1]> = {}) {
  return addRider(env.db.pool, { name: `Rider ${riderN++}`, phone: '0700111222', actor: 'admin', ...over });
}
