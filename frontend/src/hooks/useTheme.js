import { useSyncExternalStore } from 'react';

// Light / dark / follow-the-device, remembered per browser.
//
//   preference: 'system' | 'light' | 'dark'  (what the person picked; 'system' is the default and stores nothing)
//   resolved:   'light' | 'dark'             (what is actually showing)
//
// The page's colours are CSS variables (index.css); this only sets data-theme on <html>, plus color-scheme so
// scrollbars and native form controls follow. index.html runs the same logic before the first paint so a dark
// device never flashes white.
const KEY = 'ut_theme';
const listeners = new Set();
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function readPreference() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

let preference = readPreference();

export function resolveTheme(pref = preference) {
  if (pref === 'light' || pref === 'dark') return pref;
  return media?.matches ? 'dark' : 'light';
}

function apply() {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function emit() {
  apply();
  listeners.forEach((l) => l());
}

export function setThemePreference(next) {
  preference = next === 'light' || next === 'dark' ? next : 'system';
  try {
    if (preference === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, preference);
  } catch { /* storage unavailable — the choice still applies until the page is closed */ }
  emit();
}

// The device switched (sunset schedule, OS setting): follow it, unless the person chose a side.
media?.addEventListener?.('change', () => { if (preference === 'system') emit(); });
apply();

const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };

export default function useTheme() {
  const pref = useSyncExternalStore(subscribe, () => preference, () => 'system');
  return { preference: pref, resolved: resolveTheme(pref), setPreference: setThemePreference };
}
