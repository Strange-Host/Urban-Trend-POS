import { describe, it, expect } from 'vitest';
import { RETIRED_KEYS, clearRetiredPreferences } from './legacyStorage';

describe('clearRetiredPreferences', () => {
  it('removes the old sidebar and flag keys and leaves every other saved preference alone', () => {
    for (const key of RETIRED_KEYS) localStorage.setItem(key, 'x');
    localStorage.setItem('ut_cashier_home', 'till');
    localStorage.setItem('ut_theme', 'dark');

    clearRetiredPreferences();

    for (const key of RETIRED_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem('ut_cashier_home')).toBe('till');
    expect(localStorage.getItem('ut_theme')).toBe('dark');
  });

  it('does nothing, and does not throw, when storage is blocked', () => {
    const blocked = { removeItem() { throw new Error('SecurityError'); } };
    expect(() => clearRetiredPreferences(blocked)).not.toThrow();
  });
});
