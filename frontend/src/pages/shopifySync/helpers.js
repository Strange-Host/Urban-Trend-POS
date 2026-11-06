import { useState } from 'react';

// Shared by the Shopify staging page and its pieces.
export const badgeStyles = {
  new: 'bg-success-soft text-success',
  update: 'bg-accent/20 text-accent-text',
  unchanged: 'bg-line text-text-muted',
};

// Debounces a per-row save so we're not firing a PATCH on every keystroke —
// waits for a short pause in typing, then saves.
export function useDebouncedSave(delay = 500) {
  const timers = useState(() => new Map())[0];
  return (key, fn) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, delay));
  };
}
