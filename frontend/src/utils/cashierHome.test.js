import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CASHIER_HOME_KEY, getCashierHome, setCashierHome, subscribeCashierHome } from './cashierHome';

beforeEach(() => localStorage.clear());

describe('cashier home preference', () => {
  it('defaults to the Start screen', () => {
    expect(getCashierHome()).toBe('start');
  });

  it('remembers the till, and going back to Start clears the saved value', () => {
    setCashierHome('till');
    expect(getCashierHome()).toBe('till');
    expect(localStorage.getItem(CASHIER_HOME_KEY)).toBe('till');
    setCashierHome('start');
    expect(getCashierHome()).toBe('start');
    expect(localStorage.getItem(CASHIER_HOME_KEY)).toBeNull();
  });

  it('treats an unrecognised saved value as the default', () => {
    localStorage.setItem(CASHIER_HOME_KEY, 'whatever');
    expect(getCashierHome()).toBe('start');
  });

  it('tells subscribers when it changes, and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeCashierHome(fn);
    setCashierHome('till');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setCashierHome('start');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
