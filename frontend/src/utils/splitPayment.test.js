import { describe, it, expect } from 'vitest';
import { toCents, buildPayments, restFor, emptyPayment, clearedPayment, describePayments, centsToInput } from './splitPayment';

const split = (amounts = {}, refs = {}) => ({ ...emptyPayment('split'), amounts: { cash: '', mobile_money: '', card: '', ...amounts }, refs: { cash: '', mobile_money: '', card: '', ...refs } });

describe('toCents', () => {
  it('reads plain amounts exactly, with no floating point drift', () => {
    expect(toCents('500')).toBe(50000);
    expect(toCents('500.5')).toBe(50050);
    expect(toCents('500.50')).toBe(50050);
    expect(toCents('1.15')).toBe(115);
    expect(toCents('0.29')).toBe(29);
    expect(toCents('19.99')).toBe(1999);
    expect(toCents('1,250.75')).toBe(125075);
    expect(toCents(' 40 ')).toBe(4000);
    expect(toCents('.5')).toBe(50);
    expect(toCents('7.')).toBe(700);
  });

  it('treats blank as nothing paid, and rejects anything that is not an amount', () => {
    expect(toCents('')).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents('abc')).toBeNull();
    expect(toCents('-5')).toBeNull();
    expect(toCents('1.234')).toBeNull();
    expect(toCents('1e3')).toBeNull();
    expect(toCents('.')).toBeNull();
    expect(toCents('1.2.3')).toBeNull();
  });
});

describe('buildPayments', () => {
  it('single mode pays the whole total with the chosen method', () => {
    expect(buildPayments({ ...emptyPayment(), method: 'mobile_money' }, 150000)).toEqual({
      payments: [{ method: 'mobile_money', amount: 150000 }], paid: 150000, remaining: 0, error: null,
    });
  });

  it('cash + M-Pesa that adds up to the total is chargeable, with the M-Pesa code attached', () => {
    const r = buildPayments(split({ cash: '500', mobile_money: '1000' }, { mobile_money: ' QGH7XY12AB ' }), 150000);
    expect(r.error).toBeNull();
    expect(r.remaining).toBe(0);
    expect(r.payments).toEqual([
      { method: 'cash', amount: 50000 },
      { method: 'mobile_money', amount: 100000, reference: 'QGH7XY12AB' },
    ]);
    expect(r.payments.reduce((n, p) => n + p.amount, 0)).toBe(150000); // exactly the total, which is what the API demands
  });

  it('omits an empty reference and any method with nothing entered', () => {
    const r = buildPayments(split({ cash: '100', card: '0' }, { card: '   ' }), 10000);
    expect(r.payments).toEqual([{ method: 'cash', amount: 10000 }]);
    expect(r.payments[0]).not.toHaveProperty('reference');
  });

  it('says how much is still owed, or how much too much was entered', () => {
    const short = buildPayments(split({ cash: '500' }), 150000);
    expect(short.remaining).toBe(100000);
    expect(short.error).toMatch(/1,000\.00 still to be paid/);
    const over = buildPayments(split({ cash: '500', mobile_money: '1,200' }), 150000);
    expect(over.remaining).toBe(-20000);
    expect(over.error).toMatch(/200\.00 more than the total/);
  });

  it('cannot be charged with nothing entered, or with a bad amount', () => {
    expect(buildPayments(split(), 150000).error).toMatch(/Enter how much/);
    const bad = buildPayments(split({ cash: '5oo' }), 150000);
    expect(bad.error).toMatch(/Cash: enter an amount/);
    expect(bad.payments).toEqual([]);
  });

  it('handles cents correctly when splitting an odd total', () => {
    const r = buildPayments(split({ cash: '33.33', mobile_money: '66.67' }), 10000);
    expect(r.error).toBeNull();
    expect(r.payments.map((p) => p.amount)).toEqual([3333, 6667]);
  });
});

describe('restFor', () => {
  it('fills a method with whatever the others leave, so the split adds up exactly', () => {
    expect(restFor(split({ cash: '500' }), 'mobile_money', 150000)).toBe('1000.00');
    expect(restFor(split({ cash: '500', card: '250.50' }), 'mobile_money', 150000)).toBe('749.50');
  });
  it('does not count the method\'s own current amount, so tapping it again is stable', () => {
    expect(restFor(split({ cash: '500', mobile_money: '12' }), 'mobile_money', 150000)).toBe('1000.00');
  });
  it('is blank when the others already cover (or exceed) the total', () => {
    expect(restFor(split({ cash: '1500' }), 'mobile_money', 150000)).toBe('');
    expect(restFor(split({ cash: '2000' }), 'mobile_money', 150000)).toBe('');
  });
  it('round-trips through buildPayments', () => {
    const s = split({ cash: '123.45' });
    s.amounts.mobile_money = restFor(s, 'mobile_money', 99999);
    expect(buildPayments(s, 99999).error).toBeNull();
  });
});

describe('helpers', () => {
  it('clearedPayment keeps the mode and method but drops what was typed', () => {
    const cleared = clearedPayment({ ...split({ cash: '5' }, { card: 'x' }), method: 'card' });
    expect(cleared).toEqual({ ...emptyPayment('split', 'card') });
  });
  it('describes a finished sale\'s payments', () => {
    expect(describePayments([{ method: 'cash', amount: 50000 }, { method: 'mobile_money', amount: 100000 }])).toBe('Cash 500.00 + M-Pesa 1,000.00');
    expect(describePayments(undefined)).toBe('');
  });
  it('centsToInput gives a plain two-decimal string', () => {
    expect(centsToInput(74950)).toBe('749.50');
  });
});
