import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addOrganization, addRider, courierPayableCents, courierProfile, getCourier, listCouriers, setCourierActive } from '../src/couriers/couriers.js';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { getOrderTx, recordDeliveryAttempt } from '../src/orders/orders.js';
import { dispatch, makeEnv, newOrder, newOrg, newRider, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

describe('the courier registry', () => {
  it('adds riders and organizations with their own details, with no code change', async () => {
    const rider = await addRider(env.db.pool, { name: 'Sam Odhiambo', phone: '0712 345 678', idNumber: '12345678', vehiclePlate: 'KMFB 123A', actor: 'manager' });
    expect(rider).toMatchObject({ kind: 'rider', name: 'Sam Odhiambo', idNumber: '12345678', vehiclePlate: 'KMFB 123A', collectsPayment: false, active: true });

    const org = await addOrganization(env.db.pool, { name: 'Speedy Couriers', contactPerson: 'Jane', phone: '0722000000', agentNames: ['Peter', ' Mary ', ''], collectsPayment: true, overdueLimitCents: 500_000, actor: 'manager' });
    expect(org).toMatchObject({ kind: 'organization', contactPerson: 'Jane', agentNames: ['Peter', 'Mary'], collectsPayment: true, overdueLimitCents: 500_000, overdueAfterDays: 14 });
    const nonCollecting = await addOrganization(env.db.pool, { name: 'G4S Parcels', collectsPayment: false, actor: 'manager' });
    expect(nonCollecting.collectsPayment).toBe(false);

    expect((await listCouriers(env.db.pool, { kind: 'rider' })).map((c) => c.name)).toEqual(['Sam Odhiambo']);
    expect((await listCouriers(env.db.pool, { kind: 'organization' })).map((c) => c.name)).toEqual(['G4S Parcels', 'Speedy Couriers']);
  });

  it('requires a name and who added it, and refuses a duplicate name of the same kind', async () => {
    await expect(addRider(env.db.pool, { name: '  ', actor: 'm' })).rejects.toMatchObject({ code: 'COURIER_FIELD_REQUIRED' });
    await expect(addRider(env.db.pool, { name: 'X', actor: '' })).rejects.toMatchObject({ code: 'COURIER_FIELD_REQUIRED' });
    await addRider(env.db.pool, { name: 'Unique Rider', actor: 'm' });
    await expect(addRider(env.db.pool, { name: 'unique rider', actor: 'm' })).rejects.toMatchObject({ code: 'COURIER_EXISTS' });
    await expect(addOrganization(env.db.pool, { name: 'Unique Rider', collectsPayment: false, actor: 'm' })).resolves.toBeDefined(); // another kind: allowed
  });

  it('riders can never collect money or carry organization fields, whatever the code does (database rule)', async () => {
    await expect(env.db.pool.query(`INSERT INTO couriers (kind, name, collects_payment, created_by) VALUES ('rider', 'Bad Rider', true, 't')`)).rejects.toThrow(/riders_never_collect/);
    await expect(env.db.pool.query(`INSERT INTO couriers (kind, name, contact_person, created_by) VALUES ('rider', 'Bad Rider 2', 'x', 't')`)).rejects.toThrow(/rider_has_no_org_fields/);
    await expect(env.db.pool.query(`INSERT INTO couriers (kind, name, vehicle_plate, created_by) VALUES ('organization', 'Bad Org', 'KAA 1', 't')`)).rejects.toThrow(/org_has_no_rider_fields/);
  });

  it('couriers are deactivated, never deleted; their kind and history never change', async () => {
    const r = await newRider(env);
    expect((await setCourierActive(env.db.pool, { courierId: r.id, active: false })).active).toBe(false);
    expect((await setCourierActive(env.db.pool, { courierId: r.id, active: true })).active).toBe(true);
    await expect(env.db.pool.query(`DELETE FROM couriers WHERE id = $1`, [r.id])).rejects.toThrow(/cannot be deleted/);
    await expect(env.db.pool.query(`UPDATE couriers SET kind = 'organization' WHERE id = $1`, [r.id])).rejects.toThrow(/never change/);
    await expect(env.db.pool.query(`TRUNCATE couriers CASCADE`)).rejects.toThrow(/immutable/);
    await expect(setCourierActive(env.db.pool, { courierId: 999_999, active: false })).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
  });
});

describe('Rule 11: every dispatch has a package fee line', () => {
  it('a dispatch needs a courier and a fee; there is no default', async () => {
    const o = await newOrder(env);
    const rider = await newRider(env);
    const { dispatchOrder } = await import('../src/orders/orders.js');
    // @ts-expect-error: deliberately missing the fee, to prove the runtime refuses it too
    await expect(dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a', courierId: rider.id })).rejects.toMatchObject({ code: 'DISPATCH_NEEDS_FEE' });
    // @ts-expect-error: deliberately missing the courier
    await expect(dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a', packageFee: { amountCents: 1000 } })).rejects.toMatchObject({ code: 'DISPATCH_NEEDS_COURIER' });
    await expect(dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a', courierId: rider.id, packageFee: { amountCents: -5 } })).rejects.toMatchObject({ code: 'DISPATCH_NEEDS_FEE' });
    await expect(dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a', courierId: rider.id, packageFee: { amountCents: 10.5 } })).rejects.toMatchObject({ code: 'DISPATCH_NEEDS_FEE' });
    expect((await getOrderTx(env.db.pool, o.orderRef))!.status).toBe('awaiting_dispatch'); // nothing half-done
  });

  it('a zero fee needs a reason', async () => {
    const o = await newOrder(env);
    await expect(dispatch(env, o.orderRef, 'a', { feeCents: 0 })).rejects.toMatchObject({ code: 'FEE_ZERO_NEEDS_REASON' });
    await expect(dispatch(env, o.orderRef, 'a', { feeCents: 0, zeroReason: '   ' })).rejects.toMatchObject({ code: 'FEE_ZERO_NEEDS_REASON' });
    const d = await dispatch(env, o.orderRef, 'a', { feeCents: 0, zeroReason: 'Staff member delivered it himself' });
    expect(d.dispatch).toMatchObject({ packageFeeCents: 0, zeroReason: 'Staff member delivered it himself' });
    expect((await env.db.pool.query(`SELECT entry_id FROM package_fees WHERE order_ref = $1`, [o.orderRef])).rows[0].entry_id).toBeNull(); // nothing owed, nothing posted
  });

  it('records the fee, books it to the ledger, and owes the courier from the moment of dispatch', async () => {
    const rider = await newRider(env);
    const o = await newOrder(env);
    const d = await dispatch(env, o.orderRef, 'dispatcher', { courierId: rider.id, feeCents: 35_000 });
    expect(d.status).toBe('dispatched');
    expect(d.dispatch).toMatchObject({ courierId: rider.id, courierName: rider.name, packageFeeCents: 35_000 });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(35_000);
    expect(await accountBalance(env.db.pool, 'COURIER_PACKAGE_FEES', { orderRef: o.orderRef })).toBe(35_000);
    expect(d.events.find((e) => e.type === 'dispatched')?.data).toMatchObject({ courier_id: rider.id, package_fee_cents: 35_000 });
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
  });

  it('the fee is still due when the customer does not claim the parcel', async () => {
    const rider = await newRider(env);
    const o = await newOrder(env);
    await dispatch(env, o.orderRef, 'a', { courierId: rider.id, feeCents: 25_000 });
    const back = await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'not_claimed', reason: 'phone off', actor: 'a' });
    expect(back.status).toBe('returning');
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(25_000);
  });

  it('a rescheduled attempt does not create a second fee', async () => {
    const rider = await newRider(env);
    const o = await newOrder(env);
    await dispatch(env, o.orderRef, 'a', { courierId: rider.id, feeCents: 25_000 });
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'rescheduled', reason: 'away', rescheduleFor: '2026-12-01', actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'a' });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(25_000);
  });

  it('THE DATABASE refuses to mark an order dispatched without a fee line, even if the code is bypassed', async () => {
    const o = await newOrder(env);
    await expect(env.db.pool.query(`UPDATE orders SET status = 'dispatched', dispatched_at = now() WHERE id = $1`, [o.id])).rejects.toThrow(/without a package fee line/);
    expect((await getOrderTx(env.db.pool, o.orderRef))!.status).toBe('awaiting_dispatch');
  });

  it('refuses a deactivated or unknown courier', async () => {
    const rider = await newRider(env);
    await setCourierActive(env.db.pool, { courierId: rider.id, active: false });
    const o = await newOrder(env);
    await expect(dispatch(env, o.orderRef, 'a', { courierId: rider.id })).rejects.toMatchObject({ code: 'COURIER_INACTIVE' });
    await expect(dispatch(env, o.orderRef, 'a', { courierId: 999_999 })).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
    expect((await getOrderTx(env.db.pool, o.orderRef))!.status).toBe('awaiting_dispatch');
  });

  it('a fee line cannot be edited or deleted, and an order has only one', async () => {
    const o = await newOrder(env);
    await dispatch(env, o.orderRef);
    await expect(env.db.pool.query(`UPDATE package_fees SET amount_cents = 1 WHERE order_ref = $1`, [o.orderRef])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM package_fees WHERE order_ref = $1`, [o.orderRef])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(
      `INSERT INTO package_fees (order_id, order_ref, courier_id, amount_cents, entry_id, recorded_by) SELECT $1, $2, courier_id, 0, NULL, 't' FROM package_fees WHERE order_id = $1`, [o.id, o.orderRef])).rejects.toThrow();
  });

  it('the courier profile shows what is owed, what is in progress and what has been earned', async () => {
    const rider = await newRider(env);
    const a = await newOrder(env); const b = await newOrder(env);
    await dispatch(env, a.orderRef, 'a', { courierId: rider.id, feeCents: 20_000 });
    await dispatch(env, b.orderRef, 'a', { courierId: rider.id, feeCents: 30_000 });
    await recordDeliveryAttempt(env.ctx, { orderRef: a.orderRef, outcome: 'delivered', actor: 'a' });
    const p = await courierProfile(env.db.pool, rider.id);
    expect(p).toMatchObject({ owedCents: 50_000, unpaidFeesCents: 50_000, unpaidCostsCents: 0, dispatchesInProgress: 1, totalEarnedCents: 50_000 });
    expect(p.oldestUnpaidAt).toBeInstanceOf(Date);
    expect((await getCourier(env.db.pool, rider.id))?.name).toBe(rider.name);
    await expect(courierProfile(env.db.pool, 999_999)).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
  });

  it('the ledger can attribute entries to a courier, and refuses one that does not exist', async () => {
    const { postEntry, dr, cr } = await import('../src/ledger/ledger.js');
    await expect(postEntry(env.db.pool, { description: 'x', actor: 't', courierId: 999_999, lines: [dr('COURIER_PACKAGE_FEES', 1), cr('COURIER_PAYABLE', 1)] }))
      .rejects.toMatchObject({ code: 'LEDGER_UNKNOWN_COURIER' });
  });
});
