// Filter chips: the SalesHistory channel-filter style (small text, bordered), used for narrowing a list rather than
// switching pages. Page tabs are Tabs (components/shell/Tabs.jsx). Same interaction model: a controlled `active` key and an
// onChange callback.
import { useRef } from 'react';
import useScrollSelectedIntoView from '../hooks/useScrollSelectedIntoView';

export default function TabBar({ tabs, active, onChange, className = '' }) {
  const stripRef = useRef(null);
  useScrollSelectedIntoView(stripRef, active);

  return (
    // flex-nowrap + overflow: on a phone a long list scrolls sideways instead of pushing the page wider than the screen.
    <div ref={stripRef} className={`flex flex-nowrap gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`shrink-0 whitespace-nowrap px-3 py-2 sm:py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            active === t.key ? 'bg-ink text-white border-ink' : 'border-line text-text-muted hover:border-text-muted'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
