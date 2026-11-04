import { describe, it, expect } from 'vitest';
import { pctChange, dailySeries } from './trends';

describe('pctChange', () => {
  it('computes the change against the previous period', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(100, 100)).toBe(0);
  });
  it('is null when there is nothing to compare with', () => {
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(100, undefined)).toBeNull();
    expect(pctChange(undefined, 100)).toBeNull();
  });
});

describe('dailySeries', () => {
  const rows = [
    { day: '2026-11-02', source_type: 'local', revenue: 300 },
    { day: '2026-11-01', source_type: 'local', revenue: 100 },
    { day: '2026-11-01', source_type: 'shopify', revenue: 40 },
    { day: '2026-11-02', source_type: 'shopify', revenue: 60 },
    { day: '2026-11-03', source_type: 'shopify', revenue: 25 },
  ];
  it('sums every channel per day, oldest first', () => {
    expect(dailySeries(rows)).toEqual([140, 360, 25]);
  });
  it('keeps the same days when filtered, with 0 where the channel did not sell', () => {
    expect(dailySeries(rows, (r) => r.source_type === 'local')).toEqual([100, 300, 0]);
    expect(dailySeries(rows, (r) => r.source_type !== 'local')).toEqual([40, 60, 25]);
  });
  it('copes with no data', () => {
    expect(dailySeries(undefined)).toEqual([]);
  });
});
