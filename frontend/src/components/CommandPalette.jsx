import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { rank } from '../utils/fuzzy';

// Ctrl/Cmd+K "go to…" box. Type a few letters of a page (or what you do there: "mpesa", "void", "salary"),
// arrow keys to pick, Enter to go. With nothing typed it lists the pages you used last, then everything.
//
//   items:   nav items the person may open  { to, label, icon, group, keywords }
//   actions: other things to run             { id, label, icon, keywords, run }
//   recent:  route paths, newest first

export default function CommandPalette({ open, onClose, items, actions = [], recent = [] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  const returnFocusTo = useRef(null);
  const listId = useId();

  // Reset every time it opens; give focus back to whatever had it when it closes. (The input takes focus by itself
  // the moment it mounts, so keystrokes typed right after Ctrl+K are not lost.)
  useEffect(() => {
    if (open) {
      returnFocusTo.current = document.activeElement;
      setQuery('');
      setActive(0);
    } else if (returnFocusTo.current) {
      returnFocusTo.current.focus?.();
      returnFocusTo.current = null;
    }
  }, [open]);

  const results = useMemo(() => {
    const pages = items.map((i) => ({ ...i, kind: 'page', id: i.to }));
    const acts = actions.map((a) => ({ ...a, kind: 'action', group: 'Action' }));
    if (!query.trim()) {
      const byPath = new Map(pages.map((p) => [p.to, p]));
      const recents = recent.map((p) => byPath.get(p)).filter(Boolean).slice(0, 5).map((p) => ({ ...p, section: 'Recent', id: `recent-${p.to}` }));
      const recentPaths = new Set(recents.map((r) => r.to));
      return [
        ...recents,
        ...pages.filter((p) => !recentPaths.has(p.to)).map((p) => ({ ...p, section: 'Pages' })),
        ...acts.map((a) => ({ ...a, section: 'Actions' })),
      ];
    }
    return [...pages, ...acts]
      .map((e) => ({ e, s: rank(e, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ ...x.e, section: x.e.kind === 'action' ? 'Actions' : 'Pages' }));
  }, [items, actions, recent, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, results]);

  if (!open) return null;

  function choose(entry) {
    if (!entry) return;
    onClose();
    if (entry.kind === 'action') entry.run();
    else navigate(entry.to);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'Tab') e.preventDefault(); // keep focus in the box while it is open
  }

  let lastSection = null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center px-3 pt-[12vh] bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Go to" className="w-full max-w-lg bg-surface text-text border border-line rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 border-b border-line focus-within:border-accent transition-colors">
          <Search size={18} className="text-text-muted shrink-0" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-label="Go to a page or action"
            placeholder="Go to a page…"
            autoComplete="off"
            // The page-wide :focus-visible ring (index.css) would draw a box around a field that is already
            // the whole point of the dialog; the underline on its row shows focus instead.
            style={{ outline: 'none' }}
            className="flex-1 py-3.5 bg-transparent text-sm placeholder:text-text-muted"
          />
          <kbd className="hidden sm:block font-mono text-[10px] text-text-muted border border-line rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <ul id={listId} ref={listRef} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-text-muted" role="presentation">Nothing matches “{query}”.</li>}
          {results.map((entry, idx) => {
            const header = entry.section !== lastSection ? entry.section : null;
            lastSection = entry.section;
            const Icon = entry.icon;
            const isActive = idx === active;
            return (
              <li key={`${entry.id}-${idx}`} role="presentation">
                {header && <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">{header}</div>}
                <div
                  id={`${listId}-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => choose(entry)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer ${isActive ? 'bg-paper' : ''}`}
                >
                  {Icon && <Icon size={16} strokeWidth={1.75} className="text-text-muted shrink-0" aria-hidden="true" />}
                  <span className="flex-1 truncate">{entry.label}</span>
                  {entry.group && <span className="text-xs text-text-muted">{entry.group}</span>}
                  {isActive && <CornerDownLeft size={14} className="text-text-muted shrink-0" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
