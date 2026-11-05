import { useEffect } from 'react';

// Keep the selected tab in view when a tab strip scrolls sideways (e.g. arriving by link on a later tab).
// Finds the selected one by aria-selected (button tabs) or aria-current (link tabs).
export default function useScrollSelectedIntoView(stripRef, active) {
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip && strip.querySelector('[aria-selected="true"], [aria-current="page"]');
    if (!el) return;
    const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
    strip.scrollTo?.({ left: Math.max(0, left), behavior: 'smooth' });
  }, [stripRef, active]);
}
