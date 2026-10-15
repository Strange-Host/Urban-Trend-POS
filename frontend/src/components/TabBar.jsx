// Two visual variants, both extracted from real duplicated markup rather
// than invented: "page" is the Finance/Catalog page-switcher style
// (solid pill, no border on active), "filter" is the SalesHistory
// channel-filter style (smaller text, bordered). Same interaction model
// either way — a controlled `active` key and an onChange callback.
import { useEffect, useRef } from 'react';

export default function TabBar({ tabs, active, onChange, variant = 'page', className = '' }) {
  const base =
    variant === 'filter'
      ? 'shrink-0 whitespace-nowrap px-3 py-2 sm:py-1.5 rounded-lg text-xs font-medium border transition-colors'
      : 'shrink-0 whitespace-nowrap px-3.5 py-2 sm:py-1.5 rounded-lg text-sm font-medium transition-colors';
  const activeCls = variant === 'filter' ? 'bg-ink text-white border-ink' : 'bg-ink text-white';
  const inactiveCls =
    variant === 'filter'
      ? 'border-line text-text-muted hover:border-text-muted'
      : 'bg-surface border border-line text-text-muted hover:text-text';

  // Keep the selected tab in view when the strip scrolls (e.g. arriving by link on a later tab).
  const stripRef = useRef(null);
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip && strip.querySelector('[aria-selected="true"]');
    if (!el) return;
    const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [active]);

  return (
    // flex-nowrap + overflow: on a phone a long tab list scrolls sideways instead
    // of pushing the whole page wider than the screen.
    <div ref={stripRef} className={`flex flex-nowrap gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`${base} ${active === t.key ? activeCls : inactiveCls}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
