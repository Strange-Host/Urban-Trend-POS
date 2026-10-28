import type { Pool } from '../src/db/pool.js';
import type { StoreFetch } from '../src/integrations/storeClients.js';
import { freshPhone } from './orderHelpers.js';

export interface Call { url: URL; method: string; headers: Record<string, string>; body?: string }
export type FakeFetch = StoreFetch & { calls: Call[] };

/** A store to talk to. It records every request, so a test can check what was asked, with what credentials, and how often. */
export function fakeFetch(handler: (c: Call) => Response | Promise<Response>): FakeFetch {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const call: Call = { url, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    return handler(call);
  }) as FakeFetch;
  f.calls = calls;
  return f;
}
export const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });

let n = 0;
type J = Record<string, unknown>;
export const shopifyOrder = (sku: string, over: J = {}): J => ({
  id: 7_000_000 + n++, name: `#${2000 + n}`, order_number: 2000 + n, financial_status: 'pending', fulfillment_status: null, cancelled_at: null,
  payment_gateway_names: ['Cash on Delivery (COD)'], email: 'amina@example.com', note: null,
  shipping_address: { name: 'Amina K', phone: freshPhone(), city: 'Nairobi' },
  line_items: [{ sku, title: 'Online item', quantity: 2, price: '1500.00', total_discount: '0.00' }], ...over,
});
export const wooOrder = (sku: string, over: J = {}): J => ({
  id: 12_000 + n++, number: String(12_000 + n), status: 'processing', payment_method: 'cod', payment_method_title: 'Cash on delivery', date_paid: null, customer_note: '',
  billing: { first_name: 'Otieno', last_name: 'B', phone: freshPhone(), email: 'o@example.com', city: 'Kisumu' }, shipping: { first_name: 'Otieno', last_name: 'B', city: 'Kisumu' },
  line_items: [{ sku, name: 'Woo item', quantity: 2, subtotal: '2000.00', total: '1800.00' }], ...over,
});

/** Every table's contents as one fingerprint each: if anything anywhere changes, this changes. */
export async function fingerprint(pool: Pool): Promise<Record<string, string>> {
  const tables = (await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows;
  const out: Record<string, string> = {};
  for (const { table_name: t } of tables) out[t] = (await pool.query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
  return out;
}
