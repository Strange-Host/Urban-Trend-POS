const { ALPHABET, SPACE, checkChar, formatRef, isValidRef, normalizeLegacyRef, normalizeOrderRef, scramble, unscramble } = require('../src/ledger/orderRef.js');

const KEY = 'test-key-for-order-refs-0123456789abcdef';
const OTHER_KEY = 'a-completely-different-key-0123456789abcdef';

describe('Order reference format and generation (pure)', () => {
  it('has the documented shape: UT- + 7 characters + 1 check character, no look-alike characters', () => {
    expect(ALPHABET).toHaveLength(32);
    expect(ALPHABET).not.toMatch(/[01IO]/);
    for (let n = 1; n <= 500; n++) expect(formatRef(n, KEY)).toMatch(/^UT-[2-9A-HJ-NP-Z]{8}$/);
  });

  it('is unique by construction: 50,000 consecutive sequence values give 50,000 different references', () => {
    const seen = new Set();
    for (let n = 1; n <= 50_000; n++) seen.add(formatRef(n, KEY));
    expect(seen.size).toBe(50_000);
  });

  it('is a true bijection: every scrambled value maps back to its sequence number, including both ends of the space', () => {
    for (const n of [0, 1, 2, 3, 1000, 123_456_789, SPACE - 2, SPACE - 1]) {
      const v = scramble(n, KEY);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(SPACE);
      expect(unscramble(v, KEY)).toBe(n);
    }
  });

  it('is not sequential or guessable: the next sequence number gives an unrelated reference', () => {
    let adjacent = 0;
    let sharedPrefix = 0;
    for (let n = 1; n <= 2000; n++) {
      if (Math.abs(scramble(n + 1, KEY) - scramble(n, KEY)) <= 1) adjacent++;
      if (formatRef(n, KEY).slice(0, 5) === formatRef(n + 1, KEY).slice(0, 5)) sharedPrefix++;
    }
    expect(adjacent).toBe(0);
    expect(sharedPrefix).toBeLessThan(10); // a sequential scheme would share a prefix almost every time
  });

  it('depends on the secret key', () => {
    expect(formatRef(1, KEY)).not.toBe(formatRef(1, OTHER_KEY));
  });

  it('refuses a missing or short key and out-of-range sequence values', () => {
    expect(() => formatRef(1, '')).toThrow(/ORDER_REF_KEY/);
    expect(() => formatRef(1, 'short')).toThrow(/ORDER_REF_KEY/);
    expect(() => formatRef(SPACE, KEY)).toThrow(RangeError);
    expect(() => formatRef(-1, KEY)).toThrow(RangeError);
  });
});

describe('check character and typing tolerance (pure)', () => {
  const sample = Array.from({ length: 300 }, (_, i) => formatRef(i + 1, KEY));

  it('every generated reference validates', () => {
    for (const r of sample) { expect(isValidRef(r)).toBe(true); expect(normalizeOrderRef(r)).toBe(r); }
  });

  it('catches EVERY single-character typo', () => {
    let tried = 0;
    for (const ref of sample.slice(0, 100)) {
      const body = ref.slice(3);
      for (let i = 0; i < 8; i++) {
        for (const ch of ALPHABET) {
          if (ch === body[i]) continue;
          tried++;
          expect(normalizeOrderRef(`UT-${body.slice(0, i)}${ch}${body.slice(i + 1)}`), `${ref} position ${i} -> ${ch}`).toBeNull();
        }
      }
    }
    expect(tried).toBe(100 * 8 * 31);
  });

  it('catches nearly all swaps of two adjacent characters', () => {
    let swaps = 0;
    let caught = 0;
    for (const ref of sample) {
      const body = ref.slice(3);
      for (let i = 0; i < 7; i++) {
        if (body[i] === body[i + 1]) continue;
        swaps++;
        const swapped = body.slice(0, i) + body[i + 1] + body[i] + body.slice(i + 2);
        if (normalizeOrderRef(swapped) === null) caught++;
      }
    }
    expect(caught / swaps).toBeGreaterThan(0.9);
  });

  it('ignores case, spaces and the dash, and the UT prefix', () => {
    const ref = formatRef(42, KEY);
    const body = ref.slice(3);
    for (const typed of [ref.toLowerCase(), `ut ${body.toLowerCase()}`, ` ${ref} `, body, `UT${body}`, `ut-${body.slice(0, 4)} ${body.slice(4)}`]) {
      expect(normalizeOrderRef(typed), typed).toBe(ref);
    }
  });

  it('rejects look-alike characters, wrong lengths and junk', () => {
    const body = formatRef(42, KEY).slice(3);
    expect(normalizeOrderRef(`UT-${body.slice(0, 7)}0`)).toBeNull(); // 0 is never used
    expect(normalizeOrderRef(`UT-${body.slice(0, 7)}`)).toBeNull();
    expect(normalizeOrderRef(`UT-${body}2`)).toBeNull();
    expect(normalizeOrderRef('')).toBeNull();
    expect(normalizeOrderRef('hello world')).toBeNull();
    expect(checkChar('2222222')).toMatch(/^[2-9A-HJ-NP-Z]$/);
  });

  it('recognises old-style codes separately', () => {
    expect(normalizeLegacyRef('UT000123')).toBe('UT000123');
    expect(normalizeLegacyRef(' ut 000123 ')).toBe('UT000123');
    expect(normalizeLegacyRef('UT-7K49M2XQ')).toBeNull();
    expect(normalizeOrderRef('UT000123')).toBeNull();
  });
});
