import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import useStackedTableLabels from './useStackedTableLabels';
import useModules from '../hooks/useModules';
import useSlidingPill from '../hooks/useSlidingPill';
import ConnectionDot from './ConnectionDot';
import UserMenu from './UserMenu';
import CommandPalette from './CommandPalette';
import useRecentPages from '../hooks/useRecentPages';
import { setThemePreference } from '../hooks/useTheme';
import { PINNED_TOP, GROUPS, PINNED_BOTTOM, ALL_ITEMS, filterVisible } from './navItems';
import {
  ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Lock, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, X,
} from 'lucide-react';

// Roles that see only a handful of pages get one plain list instead of group headings: two clicks to reach
// five items is a bad trade.
const FLAT_BELOW = 8;

const COLLAPSE_KEY = 'ut_nav_collapsed';
const MODE_KEY = 'ut_sidebar_mode';
const LEGACY_HIDDEN_KEY = 'ut_sidebar_hidden'; // first version of the hide toggle: '1' = hidden

// Desktop sidebar modes:
//   expanded — the normal wide sidebar
//   rail     — a narrow strip of icons (labels appear as tooltips), the page gets the room back
//   hidden   — gone; the phone-style top bar with a menu button takes over and the sidebar slides in over the page
// Below lg the sidebar is always the slide-in drawer, whatever the mode.
const MODES = ['expanded', 'rail', 'hidden'];

function readMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (MODES.includes(saved)) return saved;
    if (localStorage.getItem(LEGACY_HIDDEN_KEY) === '1') return 'hidden';
  } catch { /* storage unavailable — fall through to the default */ }
  return 'expanded';
}

function NavItem({ item, onNavigate, nested = false, rail = false, onTip }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      onMouseEnter={rail ? (e) => onTip(item.label, e.currentTarget) : undefined}
      onFocus={rail ? (e) => onTip(item.label, e.currentTarget) : undefined}
      onMouseLeave={rail ? () => onTip(null) : undefined}
      onBlur={rail ? () => onTip(null) : undefined}
      className={({ isActive }) =>
        // `relative` so the item paints above the sliding pill (the amber highlight that
        // glides to the active item); the active item itself has no background of its own.
        `relative flex items-center gap-3 rounded-lg text-sm transition-colors ${nested ? 'pl-8 pr-3 py-2' : 'px-3 py-2.5 font-medium'} ${
          rail ? 'lg:justify-center lg:px-0 lg:pl-0 lg:py-2.5' : ''
        } ${
          isActive
            ? 'text-accent-ink font-medium'
            : 'text-white/70 hover:bg-white/10 hover:text-white'
        }`
      }
    >
      <item.icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      <span className={rail ? 'lg:sr-only' : ''}>{item.label}</span>
    </NavLink>
  );
}

// Small text+icon button for the footer toolbar (expanded) or an icon-only one (rail).
function DockButton({ icon: Icon, label, onClick, rail }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`hidden lg:flex items-center gap-2 rounded-lg text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors ${
        rail ? 'justify-center w-10 h-9' : 'px-2.5 py-1.5'
      }`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {!rail && <span>{label}</span>}
    </button>
  );
}

export default function Layout() {
  const { hasRole, can, lock } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef(null);
  useStackedTableLabels(mainRef);
  const modules = useModules();
  const { rootRef: navRootRef, pillProps: navPill } = useSlidingPill('y', location.pathname);

  // Which groups the user has collapsed. Persisted so the sidebar looks
  // the same every shift — a cashier who only ever uses Sell shouldn't
  // have to re-collapse the other groups every morning.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
    } catch {
      return new Set();
    }
  });

  // `module` marks menu items that belong to an optional module (hidden while it is switched off).
  const visible = (items) => filterVisible(items, { hasRole, can, modules });
  const activeGroupId = GROUPS.find((g) => g.items.some((i) => i.to === location.pathname))?.id;

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  function toggleGroup(id) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const [mode, setModeState] = useState(readMode);
  const hidden = mode === 'hidden';
  const rail = mode === 'rail';
  function setMode(next) {
    setNavOpen(false);
    setTip(null);
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
      localStorage.removeItem(LEGACY_HIDDEN_KEY);
    } catch { /* storage unavailable — the choice still applies for this session */ }
  }

  const closeNav = () => setNavOpen(false);

  // Esc closes the slide-in drawer.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Ctrl/Cmd+K opens the "go to…" palette from anywhere.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const recentPaths = useRecentPages();

  // Tooltip for the icon rail. One element for the whole sidebar (the nav list scrolls, which would clip a
  // tooltip drawn inside it), positioned from the hovered item's box.
  const asideRef = useRef(null);
  const [tip, setTip] = useState(null);
  function showTip(label, el) {
    if (!label || !el || !asideRef.current) { setTip(null); return; }
    const a = asideRef.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTip({ label, top: r.top - a.top + r.height / 2 });
  }

  const topItems = visible(PINNED_TOP);
  const bottomItems = visible(PINNED_BOTTOM);
  const visibleGroups = GROUPS.map((g) => ({ ...g, items: visible(g.items) })).filter((g) => g.items.length > 0);
  const groupedCount = visibleGroups.reduce((n, g) => n + g.items.length, 0);
  const flat = groupedCount < FLAT_BELOW;
  // The last few pages visited (not the current one), for one-click return. Only when the list is long enough to need it.
  const visibleAll = filterVisible(ALL_ITEMS, { hasRole, can, modules });
  const recentItems = flat ? [] : recentPaths
    .filter((path) => path !== location.pathname)
    .map((path) => visibleAll.find((i) => i.to === path))
    .filter(Boolean)
    .slice(0, 3);
  const paletteActions = [
    { id: 'lock', label: 'Lock screen', icon: Lock, keywords: 'secure away', run: lock },
    { id: 'theme-dark', label: 'Theme: dark', icon: Moon, keywords: 'night appearance colours', run: () => setThemePreference('dark') },
    { id: 'theme-light', label: 'Theme: light', icon: Sun, keywords: 'day appearance colours', run: () => setThemePreference('light') },
    { id: 'theme-system', label: 'Theme: match device', icon: Monitor, keywords: 'auto system appearance colours', run: () => setThemePreference('system') },
    { id: 'mode-expanded', label: 'Sidebar: full', icon: PanelLeftOpen, keywords: 'expand pin show navigation menu', run: () => setMode('expanded') },
    { id: 'mode-rail', label: 'Sidebar: icons only', icon: ChevronsLeft, keywords: 'collapse rail narrow navigation menu', run: () => setMode('rail') },
    { id: 'mode-hidden', label: 'Sidebar: hide', icon: PanelLeftClose, keywords: 'collapse close navigation menu', run: () => setMode('hidden') },
  ];

  return (
    <div className="flex h-dvh bg-paper text-text">
      {/* Top bar for phones and tablets — hidden lg+ while the sidebar is docked; shown at every
          size once the sidebar has been hidden */}
      <div className={`${hidden ? '' : 'lg:hidden'} fixed top-0 inset-x-0 z-30 h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] bg-ink text-white flex items-center justify-between px-4`}>
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation menu"
          className="p-2 -ml-2 text-white/80 hover:text-white"
        >
          <Menu size={22} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div className="flex items-center gap-2">
          <div className="font-display font-700 text-sm tracking-tight">Urban Trends</div>
          <ConnectionDot />
        </div>
        <div className="flex items-center -mr-2">
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Search pages"
            className="p-2 text-white/80 hover:text-white"
          >
            <Search size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <NotificationBell anchor="topbar" />
        </div>
      </div>

      {navOpen && (
        <button
          aria-label="Close navigation menu"
          onClick={closeNav}
          className={`${hidden ? '' : 'lg:hidden'} fixed inset-0 z-40 bg-black/40`}
        />
      )}

      <aside
        ref={asideRef}
        className={`
          fixed inset-y-0 left-0 z-50 w-64 shrink-0 bg-ink text-white flex flex-col
          transform transition-[transform,width] duration-200 ease-out
          ${hidden ? '' : 'lg:static lg:z-20 lg:translate-x-0'}
          ${mode === 'expanded' ? 'lg:w-60' : ''}
          ${rail ? 'lg:w-16' : ''}
          ${navOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className={`px-5 py-6 border-b border-white/10 flex items-center justify-between ${rail ? 'lg:px-0 lg:py-4 lg:justify-center' : ''}`}>
          {rail && (
            <div className="hidden lg:grid w-9 h-9 rounded-lg bg-accent text-accent-ink place-items-center font-display font-700 text-sm" aria-label="Urban Trends">
              UT
            </div>
          )}
          <div className={rail ? 'lg:hidden' : ''}>
            <div className="font-display font-700 text-lg tracking-tight text-white">Urban Trends</div>
            <div className="text-xs text-white/50 font-mono mt-0.5 flex items-center gap-2">
              Main Branch
              <ConnectionDot withLabel className="font-sans" />
            </div>
          </div>
          <div className="flex items-center gap-1 -mr-2">
            {mode === 'expanded' && <NotificationBell className="hidden lg:block" anchor="sidebar" />}
            {/* The slide-in drawer (phones, or desktop with the sidebar hidden) closes with this */}
            <button
              onClick={closeNav}
              aria-label="Close navigation menu"
              className={`${hidden ? '' : 'lg:hidden'} p-2 text-white/60 hover:text-white`}
            >
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>

        <nav className={`flex-1 px-3 py-4 overflow-y-auto ${rail ? 'lg:px-2' : ''}`}>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search pages"
            onMouseEnter={rail ? (e) => showTip('Search · Ctrl K', e.currentTarget) : undefined}
            onMouseLeave={rail ? () => showTip(null) : undefined}
            className={`w-full mb-3 flex items-center gap-3 px-3 py-2 rounded-lg border border-white/10 text-sm text-white/50 hover:text-white hover:border-white/25 transition-colors ${rail ? 'lg:justify-center lg:px-0' : ''}`}
          >
            <Search size={16} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
            <span className={`flex-1 text-left ${rail ? 'lg:hidden' : ''}`}>Go to…</span>
            <kbd className={`font-mono text-[10px] text-white/40 border border-white/15 rounded px-1.5 py-0.5 ${rail ? 'lg:hidden' : ''}`}>Ctrl K</kbd>
          </button>

          {/* Inner wrapper is the pill's positioning context: it is as tall as the full list, so the pill scrolls with it. */}
          <div ref={navRootRef} className="relative">
          <span {...navPill} className="sliding-pill rounded-lg bg-accent" />
          <div className="space-y-1">
            {topItems.map((item) => (
              <NavItem key={item.to} item={item} onNavigate={closeNav} rail={rail} onTip={showTip} />
            ))}
          </div>

          {recentItems.length > 0 && (
            <div className={`mt-5 ${rail ? 'lg:hidden' : ''}`}>
              <div className="px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-white/40">Recent</div>
              <div className="mt-1 space-y-0.5">
                {recentItems.map((item) => (
                  <NavItem key={item.to} item={item} onNavigate={closeNav} nested rail={rail} onTip={showTip} />
                ))}
              </div>
            </div>
          )}

          {flat ? (
            visibleGroups.length > 0 && (
              <div className={`mt-4 pt-4 border-t border-white/10 space-y-1 ${rail ? 'lg:mt-3 lg:pt-3' : ''}`}>
                {visibleGroups.flatMap((g) => g.items).map((item) => (
                  <NavItem key={item.to} item={item} onNavigate={closeNav} rail={rail} onTip={showTip} />
                ))}
              </div>
            )
          ) : visibleGroups.map((group) => {
            // The group holding the current page is always open regardless of
            // saved state: landing somewhere with no highlighted nav item
            // anywhere in view would be disorienting.
            const isOpen = !collapsed.has(group.id) || activeGroupId === group.id;

            return (
              <div key={group.id} className={`mt-5 ${rail ? 'lg:mt-3 lg:pt-3 lg:border-t lg:border-white/10' : ''}`}>
                {/* In the icon rail the group name has no room: a divider line stands in for it */}
                <button
                  onClick={() => toggleGroup(group.id)}
                  className={`w-full flex items-center justify-between px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors ${rail ? 'lg:hidden' : ''}`}
                  aria-expanded={isOpen}
                >
                  {group.label}
                  {isOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                </button>
                <div className={`mt-1 space-y-0.5 ${isOpen ? '' : 'hidden'} ${rail ? 'lg:block' : ''}`}>
                  {group.items.map((item) => (
                    <NavItem key={item.to} item={item} onNavigate={closeNav} nested rail={rail} onTip={showTip} />
                  ))}
                </div>
              </div>
            );
          })}

          {bottomItems.length > 0 && (
            <div className="mt-5 pt-4 border-t border-white/10 space-y-1">
              {bottomItems.map((item) => (
                <NavItem key={item.to} item={item} onNavigate={closeNav} rail={rail} onTip={showTip} />
              ))}
            </div>
          )}
          </div>
        </nav>

        <div className={`px-3 pt-3 pb-4 border-t border-white/10 ${rail ? 'lg:px-2' : ''}`}>
          {/* Desktop dock controls: shrink to icons / expand / hide / pin */}
          <div className={`mb-2 gap-1 ${rail ? 'lg:flex lg:flex-col lg:items-center' : 'flex'}`}>
            {mode === 'expanded' && (
              <>
                <DockButton icon={ChevronsLeft} label="Icons only" onClick={() => setMode('rail')} />
                <DockButton icon={PanelLeftClose} label="Hide" onClick={() => setMode('hidden')} />
              </>
            )}
            {rail && (
              <>
                <NotificationBell className="hidden lg:block" anchor="rail" />
                <DockButton icon={ChevronsRight} label="Expand sidebar" onClick={() => setMode('expanded')} rail />
                <DockButton icon={PanelLeftClose} label="Hide sidebar" onClick={() => setMode('hidden')} rail />
              </>
            )}
            {hidden && <DockButton icon={PanelLeftOpen} label="Pin sidebar" onClick={() => setMode('expanded')} />}
          </div>
          <div className="relative">
            <UserMenu rail={rail} onNavigate={closeNav} />
            {/* In the icon rail there is no room for the status words: the dot sits on the avatar instead */}
            {rail && (
              <span className="hidden lg:block absolute bottom-1 right-2 rounded-full ring-2 ring-ink pointer-events-none">
                <ConnectionDot />
              </span>
            )}
          </div>
        </div>

        {rail && tip && (
          <div
            role="tooltip"
            style={{ top: tip.top }}
            className="hidden lg:block absolute left-full ml-3 -translate-y-1/2 z-50 px-2.5 py-1.5 rounded-md bg-ink-soft text-white text-xs font-medium whitespace-nowrap shadow-lg pointer-events-none"
          >
            {tip.label}
          </div>
        )}
      </aside>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={visibleAll} actions={paletteActions} recent={recentPaths} />

      <main ref={mainRef} className={`flex-1 min-w-0 overflow-y-auto pt-[calc(3.5rem+env(safe-area-inset-top))] ${hidden ? '' : 'lg:pt-0'}`}>
        <Outlet />
      </main>
    </div>
  );
}
