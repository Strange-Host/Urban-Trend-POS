import { runMigrations } from '../src/db/migrate.js';
import { createOrder, type CreateOrderInput, type OrderCtx } from '../src/orders/orders.js';
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
