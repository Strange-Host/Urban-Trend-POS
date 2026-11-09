import { useRef } from 'react';
import { Link } from 'react-router-dom';
import useScrollSelectedIntoView from '../../hooks/useScrollSelectedIntoView';

// The one tab strip for pages. Two kinds of item, one look:
//   buttons  { key, label }        switch something on the same page (state or ?tab=): pass `active` and `onChange`
//   links    { key, label, to }    sibling pages, as ordinary links: pass `active`, no onChange
//
// Underline style throughout. Filters (Sales history channels, Approvals) are not tabs: they stay on TabBar's filter chips.
const UNDERLINE_ITEM = 'shrink-0 whitespace-nowrap inline-flex items-center px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors';
const UNDERLINE_ON = 'border-text text-text';
const UNDERLINE_OFF = 'border-transparent text-text-muted hover:text-text';

const HIDE_SCROLLBAR = '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

// Optional count after a tab's label (Today's Attention tab). Nothing shows for 0 or when the item has no `badge`.
function Badge({ n }) {
  if (!n || n < 1) return null;
  return <span className="ml-2 font-mono text-[11px] bg-accent/20 text-accent-text rounded-full px-1.5 py-0.5">{n}</span>;
}

export default function Tabs({ items, active, onChange, label = 'Tabs', className = '' }) {
  const stripRef = useRef(null);
  useScrollSelectedIntoView(stripRef, active);

  const asLinks = items.some((t) => t.to);
  const strip = `flex flex-nowrap overflow-x-auto ${HIDE_SCROLLBAR} gap-1 border-b border-line`;
  const itemClass = (on) => `${UNDERLINE_ITEM} ${on ? UNDERLINE_ON : UNDERLINE_OFF}`;

  if (asLinks) {
    return (
      <nav aria-label={label} className={className}>
        <div ref={stripRef} className={strip}>
          {items.map((t) => (
            <Link key={t.key} to={t.to} aria-current={active === t.key ? 'page' : undefined} className={itemClass(active === t.key)}>
              {t.label}<Badge n={t.badge} />
            </Link>
          ))}
        </div>
      </nav>
    );
  }

  return (
    // flex-nowrap + overflow: on a phone a long tab list scrolls sideways instead of pushing the page wider than the screen.
    <div ref={stripRef} className={`${strip} ${className}`} role="tablist" aria-label={label === 'Tabs' ? undefined : label}>
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={itemClass(active === t.key)}
        >
          {t.label}<Badge n={t.badge} />
        </button>
      ))}
    </div>
  );
}
