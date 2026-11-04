import { describe, it, expect } from 'vitest';
import { score, rank } from './fuzzy';

describe('score', () => {
  it('ranks a name that starts with the text above one that contains it above one with the letters in order', () => {
    expect(score('Reconciliation', 'rec')).toBeGreaterThan(score('Money at risk', 'ris'));
    expect(score('Money at risk', 'ris')).toBeGreaterThan(score('Reconciliation', 'rcn'));
    expect(score('Reconciliation', 'rcn')).toBeGreaterThan(0);
  });
  it('does not match unrelated text or single stray letters', () => {
    expect(score('Orders', 'zz')).toBe(0);
    expect(score('Orders', 'x')).toBe(0);
  });
  it('treats an empty query as matching everything equally', () => {
    expect(score('Orders', '  ')).toBe(1);
  });
});

describe('rank', () => {
  const recon = { label: 'Reconciliation', group: 'Money', keywords: 'mpesa m-pesa match paybill' };
  it('finds a page by a hidden keyword, but only on whole-word starts', () => {
    expect(rank(recon, 'mpesa')).toBeGreaterThan(0);
    expect(rank(recon, 'aybill')).toBe(0);
  });
  it('finds a page through its group name, below a direct name match', () => {
    expect(rank(recon, 'money')).toBeGreaterThan(0);
    expect(rank(recon, 'reco')).toBeGreaterThan(rank(recon, 'money'));
  });
});
