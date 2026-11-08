import { useSyncExternalStore } from 'react';

// True while the CSS media query matches, and re-renders when that changes. False where matchMedia does not exist
// (server rendering, older test environments), so callers fall back to the small-screen form.
/** @param {string} query */
export default function useMediaQuery(query) {
  /** @param {() => void} notify */
  const subscribe = (notify) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener?.('change', notify);
    return () => mq.removeEventListener?.('change', notify);
  };
  const getSnapshot = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
