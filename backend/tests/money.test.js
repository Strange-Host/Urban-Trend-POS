const { cleanupTestDb } = require('./setup');
const money = require('../src/utils/money');
const { computeDeliveryFee } = require('../src/utils/delivery');
const { assertDiscountPercent } = require('../src/utils/discounts');

afterAll(() => cleanupTestDb());

// R4: money.js is the one place that turns text into cents, cents into text, takes percentages and splits amounts.

describe('toCents', () => {
  it('reads plain, grouped and padded amounts exactly', () => {
    expect(money.toCents('19.99')).toBe(1999);
    expect(money.toCents('1,500.00')).toBe(150000);
    expect(money.toCents(' 7 ')).toBe(700);
    expect(money.toCents('.5')).toBe(50);
    expect(money.toCents('5.')).toBe(500);
    expect(money.toCents(0)).toBe(0);
    expect(money.toCents(19.99)).toBe(1999);
  });

  it('does not suffer the usual float traps', () => {
    expect(Math.round(1.15 * 100)).toBe(115);            // the float way happens to be fine here...
    expect(Math.round(8.2 * 100)).toBe(820);
    expect(money.toCents('0.29')).toBe(29);              // 0.29 * 100 = 28.999999999999996
    expect(money.toCents('1.005')).toBe(101);            // 1.005 * 100 = 100.49999999999999, so the float way loses the half cent
    expect(money.toCents(0.1 + 0.2)).toBe(30);
  });

  it('every amount to the cent survives a round trip through text', () => {
    for (let c = 0; c <= 300000; c += 7) expect(money.toCents(money.formatMoney(c))).toBe(c);
  });

  it('rounds beyond two decimals half up (half towards zero when negative, like Math.round)', () => {
    expect(money.toCents('2.345')).toBe(235);
    expect(money.toCents('2.344')).toBe(234);
    expect(money.toCents('-2.5')).toBe(-250);
    expect(money.toCents('-0.005')).toBe(0);
    expect(money.toCents('-0.0051')).toBe(-1);
  });

  it('handles exponent forms and refuses what is not an amount', () => {
    expect(money.toCents('1e2')).toBe(10000);
    expect(money.toCents(1e-7)).toBe(0);
    for (const bad of ['', 'abc', '.', '-', null, undefined, NaN, Infinity, '1e400']) expect(money.toCents(bad)).toBeNull();
    expect(money.toCents('9'.repeat(30))).toBeNull();     // too large to be exact
  });

  it('reads the leading number like parseFloat did', () => {
    expect(money.toCents('12abc')).toBe(1200);
  });
});

describe('requireCents', () => {
  it('blank is zero, rubbish is refused with a 422, and blank can be forbidden', () => {
    expect(money.requireCents('')).toBe(0);
    expect(money.requireCents(undefined)).toBe(0);
    expect(money.requireCents('12.50', 'Price')).toBe(1250);
    expect(() => money.requireCents('abc', 'Price')).toThrow(/Price "abc" is not a valid amount/);
    try { money.requireCents('abc'); } catch (e) { expect(e.statusCode).toBe(422); }
    expect(() => money.requireCents(undefined, 'Price', { allowBlank: false })).toThrow(/Price is missing/);
  });
});

describe('formatMoney', () => {
  it('formats cents without a float in sight', () => {
    expect(money.formatMoney(0)).toBe('0.00');
    expect(money.formatMoney(5)).toBe('0.05');
    expect(money.formatMoney(150050)).toBe('1500.50');
    expect(money.formatMoney(-5)).toBe('-0.05');
    expect(money.formatMoney(-150050)).toBe('-1500.50');
  });
  it('agrees with the old toFixed(2) for every amount in range', () => {
    for (let c = -5000; c <= 400000; c += 1) if (money.formatMoney(c) !== (c / 100).toFixed(2)) throw new Error(`differs at ${c}`);
  });
  it('refuses a non-integer', () => {
    expect(() => money.formatMoney(1.5)).toThrow(TypeError);
  });
});

describe('percentages', () => {
  it('percentToBp keeps two decimals', () => {
    expect(money.percentToBp('16')).toBe(1600);
    expect(money.percentToBp('2.5')).toBe(250);
    expect(money.percentToBp(0.5)).toBe(50);
  });
  it('percentOf rounds half up and matches the old float result across the shop\'s usual rates', () => {
    expect(money.percentOf(10050, 5)).toBe(503);     // 502.5 -> 503
    expect(money.percentOf(1000, '2.5')).toBe(25);
    for (const pct of [5, 2.5, 7.5, 12.5, 16, 0.5, 3.3]) {
      for (let c = 0; c <= 100000; c += 1) if (money.percentOf(c, pct) !== Math.round(c * (pct / 100))) throw new Error(`differs for ${pct}% of ${c}`);
    }
  });
  it('inclusivePart is the tax inside a tax-inclusive amount', () => {
    expect(money.inclusivePart(11600, 16)).toBe(1600);
    expect(money.inclusivePart(10000, 0)).toBe(0);
  });
  it('refuses a rate that is not a number', () => {
    expect(() => money.percentOf(100, 'abc')).toThrow(TypeError);
  });
});

describe('split and allocate', () => {
  it('shares always add back to the total', () => {
    expect(money.split(1000, 3)).toEqual([334, 333, 333]);
    expect(money.split(1000, 1)).toEqual([1000]);
    expect(money.split(0, 4)).toEqual([0, 0, 0, 0]);
    expect(money.split(-1000, 3)).toEqual([-334, -333, -333]);
    expect(money.allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(money.allocate(1000, [1, 1, 2])).toEqual([250, 250, 500]);
    expect(money.allocate(100, [0, 1])).toEqual([0, 100]);
    for (let total = 0; total < 500; total += 3) {
      for (const w of [[1, 1], [1, 2, 3], [5, 0, 7, 1], [3, 3, 3, 3, 3]]) {
        const parts = money.allocate(total, w);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      }
    }
  });
  it('refuses bad input', () => {
    expect(() => money.split(100, 0)).toThrow();
    expect(() => money.allocate(100, [])).toThrow();
    expect(() => money.allocate(100, [0, 0])).toThrow();
    expect(() => money.allocate(100.5, [1])).toThrow();
  });
});

describe('the call sites that moved onto it', () => {
  const settings = { delivery_fee_threshold_kes: '5000', delivery_fee_flat_kes: '300', delivery_fee_percent: '5' };
  it('delivery fee: flat under the threshold, a percentage of the order above it', () => {
    expect(computeDeliveryFee(499999, settings)).toBe(30000);
    expect(computeDeliveryFee(500000, settings)).toBe(25000);
    expect(computeDeliveryFee(1000010, settings)).toBe(50001);   // 500000.5 -> half up
  });
  it('the percentage discount ceiling is compared exactly', () => {
    const over = () => assertDiscountPercent({ lineDiscountTotal: 0, saleDiscount: 1001, grossTotal: 10000, maxPercent: 10 });
    const at = () => assertDiscountPercent({ lineDiscountTotal: 0, saleDiscount: 1000, grossTotal: 10000, maxPercent: 10 });
    expect(over).toThrow(/above the 10% limit/);
    expect(at).not.toThrow();
    expect(() => assertDiscountPercent({ lineDiscountTotal: 0, saleDiscount: 1251, grossTotal: 10000, maxPercent: 12.5 })).toThrow();
    expect(() => assertDiscountPercent({ lineDiscountTotal: 0, saleDiscount: 1250, grossTotal: 10000, maxPercent: 12.5 })).not.toThrow();
  });
});
