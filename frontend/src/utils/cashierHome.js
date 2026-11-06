// Where a cashier lands at "/" under the new layout (ut_ui=v2): the Start screen, or straight on the till.
//
// Default is the Start screen. A cashier who only ever sells can switch to the till from the account menu; that choice
// lives in localStorage under `ut_cashier_home` (same `ut_` prefix as the other saved preferences). 'start' removes the
// key rather than storing it, so "default" and "never set" are the same state. Has no effect on the current layout,
// where "/" is the till for cashiers as it always was.
//
// Removing the flag is part of redesign Phase 7; this preference stays, since the Start screen does.

export const CASHIER_HOME_KEY = 'ut_cashier_home';
export const DEFAULT_CASHIER_HOME = 'start';

/** @typedef {'start' | 'till'} CashierHome */

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * @param {unknown} value
 * @returns {CashierHome}
 */
function normalise(value) {
  return value === 'till' ? 'till' : DEFAULT_CASHIER_HOME;
}

/** The saved choice, or 'start' when nothing is saved, the value is unrecognised, or storage is unavailable. */
export function getCashierHome() {
  try {
    return normalise(localStorage.getItem(CASHIER_HOME_KEY));
  } catch {
    return DEFAULT_CASHIER_HOME; // private mode / storage blocked: the Start screen
  }
}

/** @param {string} home */
export function setCashierHome(home) {
  try {
    if (normalise(home) === 'till') localStorage.setItem(CASHIER_HOME_KEY, 'till');
    else localStorage.removeItem(CASHIER_HOME_KEY);
  } catch { /* storage unavailable: the choice cannot be kept here */ }
  listeners.forEach((fn) => fn());
}

/**
 * For useSyncExternalStore: re-render when the choice changes here or in another tab.
 * @param {() => void} fn
 */
export function subscribeCashierHome(fn) {
  listeners.add(fn);
  /** @param {StorageEvent} e */
  const onStorage = (e) => { if (e.key === null || e.key === CASHIER_HOME_KEY) fn(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}
