import { useRef } from 'react';
import { Link } from 'react-router-dom';
import useUiVersion from '../../hooks/useUiVersion';
import useScrollSelectedIntoView from '../../hooks/useScrollSelectedIntoView';

// The one tab strip for pages. Two kinds of item, one look:
//   buttons  { key, label }        switch something on the same page (state or ?tab=): pass `active` and `onChange`
//   links    { key, label, to }    sibling pages, as ordinary links: pass `active`, no onChange
//
// Underline style is the redesign's. While the ut_ui flag is off, button tabs keep today's pill style so the old layout
// looks exactly as before; Phase 7 deletes that branch with the flag. `appearance="underline"` forces the underline in
// both (Stock control's strip already was one). Filters (Sales history channels, Approvals) are not tabs: they stay
// on TabBar's filter variant.
const UNDERLINE_ITEM = 'shrink-0 whitespace-nowrap inline-flex items-center px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors';
const UNDERLINE_ON = 'border-text text-text';
const UNDERLINE_OFF = 'border-transparent text-text-muted hover:text-text';

const PILL_ITEM = 'shrink-0 whitespace-nowrap px-3.5 py-2 sm:py-1.5 rounded-lg text-sm font-medium transition-colors';
const PILL_ON = 'bg-ink text-white';
const PILL_OFF = 'bg-surface border border-line text-text-muted hover:text-text';

const HIDE_SCROLLBAR = '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

export default function Tabs({ items, active, onChange, appearance = 'auto', label = 'Tabs', className = '' }) {
  const { isV2 } = useUiVersion();
  const stripRef = useRef(null);
  useScrollSelectedIntoView(stripRef, active);

  const underline = appearance === 'underline' || isV2;
  const asLinks = items.some((t) => t.to);
  const strip = `flex flex-nowrap overflow-x-auto ${HIDE_SCROLLBAR} ${underline ? 'gap-1 border-b border-line' : 'gap-2'}`;
  const itemClass = (on) => (underline ? `${UNDERLINE_ITEM} ${on ? UNDERLINE_ON : UNDERLINE_OFF}` : `${PILL_ITEM} ${on ? PILL_ON : PILL_OFF}`);

  if (asLinks) {
    return (
      <nav aria-label={label} className={className}>
        <div ref={stripRef} className={strip}>
          {items.map((t) => (
            <Link key={t.key} to={t.to} aria-current={active === t.key ? 'page' : undefined} className={itemClass(active === t.key)}>
              {t.label}
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
          {t.label}
        </button>
      ))}
    </div>
  );
}
