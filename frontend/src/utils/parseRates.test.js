import { describe, it, expect } from 'vitest';
import { parseRates } from './parseRates';

describe('parseRates', () => {
  it('reads area, fee, optional courier and notes, from commas or tabs', () => {
    expect(parseRates('Ruiru, 350\nThika\t450\tg4s\tbulky ok')).toEqual([
      { area_name: 'Ruiru', fee: '350', courier_type: null, notes: null },
      { area_name: 'Thika', fee: '450', courier_type: 'g4s', notes: 'bulky ok' },
    ]);
  });
  it('skips a header row and blank lines, and keeps quoted commas together', () => {
    const rows = parseRates('Area,Fee\n\n"Kasarani, Nairobi","1,200"\n');
    expect(rows).toEqual([{ area_name: 'Kasarani, Nairobi', fee: '1,200', courier_type: null, notes: null }]);
  });
  it('returns nothing for empty input', () => {
    expect(parseRates('  \n')).toEqual([]);
  });
});
