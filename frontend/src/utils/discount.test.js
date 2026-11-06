import { describe, it, expect } from 'vitest';
import { discountExceedsLimit, discountPercentLabel } from './discount';

describe('discountExceedsLimit', () => {
  it('has no limit when the cap is 0, missing or the subtotal is 0', () => {
    expect(discountExceedsLimit({ discount: 99999, subtotal: 100000, maxPercent: 0 })).toBe(false);
    expect(discountExceedsLimit({ discount: 99999, subtotal: 100000, maxPercent: undefined })).toBe(false);
    expect(discountExceedsLimit({ discount: 10, subtotal: 0, maxPercent: 10 })).toBe(false);
  });

  it('allows exactly the cap and refuses one cent over it', () => {
    expect(discountExceedsLimit({ discount: 10000, subtotal: 100000, maxPercent: 10 })).toBe(false);
    expect(discountExceedsLimit({ discount: 10001, subtotal: 100000, maxPercent: 10 })).toBe(true);
  });

  it('handles a fractional cap without floating point drift', () => {
    expect(discountExceedsLimit({ discount: 1650, subtotal: 10000, maxPercent: '16.5' })).toBe(false);
    expect(discountExceedsLimit({ discount: 1651, subtotal: 10000, maxPercent: '16.5' })).toBe(true);
    expect(discountExceedsLimit({ discount: 1007, subtotal: 10000, maxPercent: 10.07 })).toBe(false);
  });
});

describe('discountPercentLabel', () => {
  it('shows the share, to one decimal at most', () => {
    expect(discountPercentLabel(10000, 100000)).toBe('10%');
    expect(discountPercentLabel(1250, 10000)).toBe('12.5%');
    expect(discountPercentLabel(333, 10000)).toBe('3.3%');
  });
  it('is 0% with no discount or no subtotal', () => {
    expect(discountPercentLabel(0, 100000)).toBe('0%');
    expect(discountPercentLabel(500, 0)).toBe('0%');
  });
});
