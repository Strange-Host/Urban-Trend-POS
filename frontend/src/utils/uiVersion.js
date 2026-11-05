// The redesign flag. 'v1' is the shell people use today; 'v2' is the side-rail redesign being built behind it.
//
// Off by default, so a person who has never touched the flag sees exactly what they saw before. It lives in
// localStorage under `ut_ui` (same `ut_` prefix as the other saved preferences) and can be flipped from the address bar:
//
//   ?ut_ui=v2   turn the new UI on for this browser
//   ?ut_ui=v1   turn it off again (clears the saved value)
//
// The query parameter is read once at start-up, saved, and then removed from the URL so a bookmarked or shared link
// does not silently switch somebody else's browser.
//
// Removing the flag is part of redesign Phase 7: delete this file, ShellSwitch and the v1 layout together.

export const UI_FLAG_KEY = 'ut_ui';
export const DEFAULT_UI_VERSION = 'v1';

const listeners = new Set();

function normalise(value) {
  return value === 'v2' ? 'v2' : DEFAULT_UI_VERSION;
}

/** The saved version, or 'v1' when nothing is saved, the value is unrecognised, or storage is unavailable. */
export function getUiVersion() {
  try {
    return normalise(localStorage.getItem(UI_FLAG_KEY));
  } catch {
    return DEFAULT_UI_VERSION; // private mode / storage blocked: fall back to today's UI
  }
}

// Mirrors the version onto <html data-ui="..."> so later phases can scope CSS to the new UI without touching the old one.
function reflectOnDocument(version) {
  try {
    document.documentElement.dataset.ui = version;
  } catch { /* no document (tests, SSR): nothing to mirror */ }
}

function notify() {
  const version = getUiVersion();
  reflectOnDocument(version);
  listeners.forEach((fn) => fn());
}

/** Save the version. 'v1' removes the key rather than storing it, so "off" and "never set" are the same state. */
export function setUiVersion(version) {
  try {
    if (normalise(version) === 'v2') localStorage.setItem(UI_FLAG_KEY, 'v2');
    else localStorage.removeItem(UI_FLAG_KEY);
  } catch { /* storage unavailable: the flag simply cannot be turned on here */ }
  notify();
}

/** For useSyncExternalStore: re-render when the flag changes here or in another tab. */
export function subscribeUiVersion(fn) {
  listeners.add(fn);
  const onStorage = (e) => { if (e.key === null || e.key === UI_FLAG_KEY) notify(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Honour ?ut_ui=v1|v2 and strip it from the address. Call once, before the app renders.
 * Anything other than v1 or v2 is ignored (but still stripped).
 */
export function applyUiFlagFromUrl(win = window) {
  try {
    const url = new URL(win.location.href);
    const requested = url.searchParams.get(UI_FLAG_KEY);
    if (requested !== null) {
      if (requested === 'v1' || requested === 'v2') setUiVersion(requested);
      url.searchParams.delete(UI_FLAG_KEY);
      win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch { /* malformed URL or no history API: leave the address as it is */ }
  reflectOnDocument(getUiVersion());
}
