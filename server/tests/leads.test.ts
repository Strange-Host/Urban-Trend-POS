import { afterAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth/service.js';
import { createProduct } from '../src/catalog/products.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { addLeadMessage, assignLead, convertLead, createLead, getLead, listLeads, setLeadStatus, updateLead } from '../src/leads/leads.js';
import { receiveStock } from '../src/stock/stock.js';
import { KEY, makeEnv, newOrder, type Env } from './orderHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };
const A = { actor: 'agent', role: 'cashier' };
const items = [{ name: 'Sneakers', quantity: 1, unitPriceCents: 500_000 }];

describe('leads', () => {
  it('records an enquiry with its first message, and adds a repeat enquiry to the open lead instead of duplicating', async () => {
    const env = await fresh();
    const a = await createLead(env.db.pool, { name: 'Amina', phone: '0711 222 333', source: 'whatsapp', productInterest: 'Red sneakers', message: 'Do you have size 40?', channel: 'whatsapp', ...A });
    expect(a.duplicate).toBe(false);
    expect(a.lead).toMatchObject({ status: 'new', source: 'whatsapp' });
    expect(a.lead.messages).toHaveLength(1);
    const b = await createLead(env.db.pool, { phone: '+254711222333', message: 'Hello? Still there?', channel: 'whatsapp', ...A });
    expect(b.duplicate).toBe(true);
    expect(b.lead.id).toBe(a.lead.id);
    expect(b.lead.messages).toHaveLength(2);
    await expect(createLead(env.db.pool, { phone: '12', ...A })).rejects.toMatchObject({ code: 'LEAD_BAD_PHONE' });
  });

  it('moves forward, refuses to go backwards, needs a reason to lose, and can be reopened', async () => {
    const env = await fresh();
    const { lead } = await createLead(env.db.pool, { name: 'B', phone: '0700 000 001', ...A });
    expect((await setLeadStatus(env.db.pool, { id: lead.id, status: 'qualified', ...A })).status).toBe('qualified');
    await expect(setLeadStatus(env.db.pool, { id: lead.id, status: 'contacted', ...A })).rejects.toMatchObject({ code: 'LEAD_STATUS_BACKWARDS' });
    await expect(setLeadStatus(env.db.pool, { id: lead.id, status: 'lost', ...A })).rejects.toMatchObject({ code: 'LEAD_LOST_REASON_REQUIRED' });
    const lost = await setLeadStatus(env.db.pool, { id: lead.id, status: 'lost', lostReason: 'Too expensive', ...A });
    expect(lost).toMatchObject({ status: 'lost', lostReason: 'Too expensive' });
    // while lost, the same phone can start a new lead; the old one then cannot be reopened beside it
    const second = await createLead(env.db.pool, { phone: '0700000001', ...A });
    expect(second.duplicate).toBe(false);
    await expect(setLeadStatus(env.db.pool, { id: lead.id, status: 'contacted', ...A })).rejects.toMatchObject({ code: 'LEAD_PHONE_HAS_OPEN_LEAD' });
  });

  it('assigns only to an active user, edits details, keeps a message log, and lists with filters', async () => {
    const env = await fresh();
    await createUser(env.db.pool, { username: 'telesales1', displayName: 'T1', role: 'cashier', actor: 'test' });
    const { lead } = await createLead(env.db.pool, { name: 'C', phone: '0700 000 002', ...A });
    await expect(assignLead(env.db.pool, { id: lead.id, assignedTo: 'ghost', ...A })).rejects.toMatchObject({ code: 'LEAD_ASSIGNEE_UNKNOWN' });
    expect((await assignLead(env.db.pool, { id: lead.id, assignedTo: 'Telesales1', ...A })).assignedTo).toBe('telesales1');
    expect((await updateLead(env.db.pool, { id: lead.id, productInterest: 'Boots', notes: 'Calls after 5pm', actor: 'agent' }))).toMatchObject({ productInterest: 'Boots', notes: 'Calls after 5pm', name: 'C' });
    const withMsg = await addLeadMessage(env.db.pool, { id: lead.id, direction: 'outbound', channel: 'sms', body: 'We have it.', actor: 'agent' });
    expect(withMsg.messages!.at(-1)).toMatchObject({ direction: 'outbound', channel: 'sms' });
    await expect(addLeadMessage(env.db.pool, { id: lead.id, direction: 'note', body: '  ', actor: 'agent' })).rejects.toMatchObject({ code: 'LEAD_EMPTY_MESSAGE' });
    await expect(env.db.pool.query(`UPDATE lead_messages SET body = 'edited'`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM leads`)).rejects.toThrow(/cannot be deleted/);
    expect((await listLeads(env.db.pool, { assignedTo: 'telesales1', limit: 10, offset: 0 })).total).toBe(1);
    expect((await listLeads(env.db.pool, { unassigned: true, limit: 10, offset: 0 })).total).toBe(0);
    expect((await listLeads(env.db.pool, { status: 'open', search: '0002', limit: 10, offset: 0 })).total).toBe(1);
  });
});

describe('convert to order', () => {
  it('creates the order and closes the lead together, and the customer and stock follow', async () => {
    const env = await fresh();
    const p = await createProduct(env.db.pool, { sku: 'BOOT-1', name: 'Boots', priceCents: 300_000, ...A });
    await receiveStock(env.db.pool, { productId: p.id, quantity: 5, ...A });
    const { lead } = await createLead(env.db.pool, { name: 'Amina', phone: '0711 222 444', source: 'website', ...A });
    const out = await convertLead(env.db.pool, KEY, { id: lead.id, items: [{ sku: 'boot-1', name: 'Boots', quantity: 2, unitPriceCents: 300_000 }], ...A });
    expect(out.order).toMatchObject({ status: 'awaiting_dispatch', customerName: 'Amina', totalCents: 600_000 });
    expect(out.lead).toMatchObject({ status: 'converted', convertedOrderRef: out.order.orderRef });
    expect((await env.db.pool.query(`SELECT 1 FROM customers`)).rows).toHaveLength(1);
    expect((await env.db.pool.query(`SELECT reserved FROM (SELECT COALESCE(sum(i.quantity),0) AS reserved FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = $1 AND o.status = 'awaiting_dispatch') x`, [p.id])).rows[0].reserved).toBe(2);
    await expect(convertLead(env.db.pool, KEY, { id: lead.id, items, ...A })).rejects.toMatchObject({ code: 'LEAD_CONVERTED' });
    await expect(setLeadStatus(env.db.pool, { id: lead.id, status: 'lost', lostReason: 'x', ...A })).rejects.toMatchObject({ code: 'LEAD_CONVERTED' });
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('changes nothing when the order cannot be created: short stock, a duplicate active order, no name', async () => {
    const env = await fresh();
    const p = await createProduct(env.db.pool, { sku: 'BOOT-2', name: 'Boots', priceCents: 300_000, ...A });
    await receiveStock(env.db.pool, { productId: p.id, quantity: 1, ...A });
    const { lead } = await createLead(env.db.pool, { name: 'Amina', phone: '0711 222 555', ...A });
    await expect(convertLead(env.db.pool, KEY, { id: lead.id, items: [{ sku: 'BOOT-2', name: 'Boots', quantity: 2, unitPriceCents: 300_000 }], ...A })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect((await getLead(env.db.pool, lead.id))!.status).toBe('new');
    expect((await env.db.pool.query(`SELECT 1 FROM orders`)).rows).toHaveLength(0);

    await newOrder(env, { customerPhone: '0711 222 555', items });
    await expect(convertLead(env.db.pool, KEY, { id: lead.id, items, ...A })).rejects.toMatchObject({ code: 'DUPLICATE_ACTIVE_ORDER' });
    expect((await getLead(env.db.pool, lead.id))!.status).toBe('new');
    expect((await env.db.pool.query(`SELECT 1 FROM orders`)).rows).toHaveLength(1);

    const nameless = await createLead(env.db.pool, { phone: '0733 000 111', ...A });
    await expect(convertLead(env.db.pool, KEY, { id: nameless.lead.id, items, ...A })).rejects.toMatchObject({ code: 'LEAD_NEEDS_NAME' });
    const ok = await convertLead(env.db.pool, KEY, { id: nameless.lead.id, items, customerName: 'Peter', ...A });
    expect(ok.lead.name).toBe('Peter');
  });

  it('refuses to convert a lost lead until it is reopened', async () => {
    const env = await fresh();
    const { lead } = await createLead(env.db.pool, { name: 'D', phone: '0744 000 111', ...A });
    await setLeadStatus(env.db.pool, { id: lead.id, status: 'lost', lostReason: 'No answer', ...A });
    await expect(convertLead(env.db.pool, KEY, { id: lead.id, items, ...A })).rejects.toMatchObject({ code: 'LEAD_LOST' });
  });

  it('lets only one of two simultaneous conversions through', async () => {
    const env = await fresh();
    const { lead } = await createLead(env.db.pool, { name: 'E', phone: '0755 000 111', ...A });
    const r = await Promise.allSettled([convertLead(env.db.pool, KEY, { id: lead.id, items, ...A }), convertLead(env.db.pool, KEY, { id: lead.id, items, ...A })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await env.db.pool.query(`SELECT 1 FROM orders`)).rows).toHaveLength(1);
  });
});
