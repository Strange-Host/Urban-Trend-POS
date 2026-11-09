// Saved preferences that belonged to the old sidebar layout and the redesign flag, both removed at cutover (redesign Phase 7).
// Nothing reads them any more, so each browser forgets them the next time the app starts. This file can be deleted once
// every browser has had a chance to run it (a few months after cutover).
export const RETIRED_KEYS = [
  'ut_ui', // the ?ut_ui=v1|v2 flag
  'ut_nav_collapsed', // sidebar group collapse state
  'ut_sidebar_mode', // sidebar display mode: expanded, rail or hidden
  'ut_sidebar_hidden', // the first version of the hide toggle
];

/** Remove the retired keys. Storage may be blocked (private mode); then there is nothing to clean. */
export function clearRetiredPreferences(storage = globalThis.localStorage) {
  try {
    for (const key of RETIRED_KEYS) storage.removeItem(key);
  } catch { /* storage unavailable: nothing was saved here */ }
}
