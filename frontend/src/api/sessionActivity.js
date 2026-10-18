// "When did the person last really use the app" - shared between browser tabs through localStorage so that
// working in one tab keeps every tab from locking. It is only a timestamp (nothing sensitive).
const KEY = 'ut_last_active';

export function markActive(ts = Date.now()) {
  try { localStorage.setItem(KEY, String(ts)); } catch { /* storage blocked: this tab just keeps its own clock */ }
  memory = ts;
}
export function markActiveIfNewer(ts) {
  if (ts > lastActive()) markActive(ts);
}
export function lastActive() {
  let v = memory;
  try { const stored = Number(localStorage.getItem(KEY)); if (stored > v) v = stored; } catch { /* ignore */ }
  return v;
}
let memory = Date.now();

// Tabs tell each other about locking and signing out (BroadcastChannel is missing on a few very old browsers).
let channel = null;
export function sessionChannel() {
  if (channel === null) channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ut-session') : false;
  return channel || null;
}
