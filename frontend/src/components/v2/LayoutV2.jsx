import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Lock, Monitor, Moon, Sun } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import useCashierHome from '../../hooks/useCashierHome';
import useModules from '../../hooks/useModules';
import useRecentPages from '../../hooks/useRecentPages';
import { setThemePreference } from '../../hooks/useTheme';
import useStackedTableLabels from '../useStackedTableLabels';
import CommandPalette from '../CommandPalette';
import { ALL_ITEMS, filterVisible, homeRouteFor } from '../navItems';
import Rail from '../shell/Rail';
import BottomBar from '../shell/BottomBar';
import StatusLine from '../shell/StatusLine';
import WorkspaceTabs from '../shell/WorkspaceTabs';
import { ShellChromeContext } from '../shell/pageChromeContext';
import { activeEntryId, buildRail, tillRail } from '../shell/railModel';

// The redesigned shell, shown instead of Layout while the ut_ui=v2 flag is on: a 76px rail on large screens, a bottom
// bar on phones, a status line, and the page in an <Outlet /> exactly as before (so no route changes between the two).
// Roles with few destinations (cashier, storekeeper) get a flat rail; everyone else gets the workspace rail.
export default function LayoutV2() {
  const { user, hasRole, can, lock } = useAuth();
  const location = useLocation();
  const modules = useModules();
  const mainRef = useRef(null);
  useStackedTableLabels(mainRef);

  // Ctrl/Cmd+K opens the "go to…" palette from anywhere; the rail's Search button opens the same one.
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

  const visibleAll = filterVisible(ALL_ITEMS, { hasRole, can, modules });
  const rail = buildRail(visibleAll);
  const { home: cashierHome } = useCashierHome();
  // A cashier's home is the Start screen unless they chose to open on the till (account menu); everyone else as navItems says.
  const homeRoute = user?.role === 'cashier' && cashierHome === 'start' ? '/start' : homeRouteFor(user?.role, can);
  // At the till a cashier gets the till's own rail (Exit till to Start, Sell, Orders, Approvals); the phone bar keeps the full list.
  const railForScreen = tillRail(rail, location.pathname, '/start');
  const activeId = activeEntryId(rail, location.pathname, homeRoute);
  const activePath = location.pathname === '/' ? homeRoute : location.pathname;
  // The pages of the current workspace, as links (workspace rail only: the flat rail already lists every page).
  const tabPages = rail.flat ? null : rail.entries.find((e) => e.id === activeId)?.pages;

  // A page's PageHeader draws the status line and workspace tabs under its own title and "claims" them, so this shell
  // draws them only above pages that have no header (the till, the dashboard for now).
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const chrome = {
    claim,
    status: <StatusLine inline />,
    workspaceTabs: <WorkspaceTabs pages={tabPages} path={activePath} inline />,
  };

  const paletteActions = [
    { id: 'lock', label: 'Lock screen', icon: Lock, keywords: 'secure away', run: lock },
    { id: 'theme-dark', label: 'Theme: dark', icon: Moon, keywords: 'night appearance colours', run: () => setThemePreference('dark') },
    { id: 'theme-light', label: 'Theme: light', icon: Sun, keywords: 'day appearance colours', run: () => setThemePreference('light') },
    { id: 'theme-system', label: 'Theme: match device', icon: Monitor, keywords: 'auto system appearance colours', run: () => setThemePreference('system') },
  ];
  const openSearch = () => setPaletteOpen(true);

  return (
    <div className="flex h-dvh bg-paper text-text">
      <Rail entries={railForScreen.entries} settings={rail.settings} activeId={activeId} homeRoute={homeRoute} onSearch={openSearch} />

      <div className="flex min-w-0 flex-1 flex-col">
        {claims === 0 && (
          <>
            <StatusLine />
            <WorkspaceTabs pages={tabPages} path={activePath} />
          </>
        )}
        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
          <ShellChromeContext.Provider value={chrome}>
            <Outlet />
          </ShellChromeContext.Provider>
        </main>
      </div>

      <BottomBar entries={rail.entries} settings={rail.settings} activeId={activeId} onSearch={openSearch} />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={visibleAll} actions={paletteActions} recent={recentPaths} />

      {/* Tester's marker: shows which UI this is while the redesign is behind the flag. Removed at cutover (Phase 7). */}
      <div
        data-testid="ui-v2-marker"
        aria-hidden="true"
        className="pointer-events-none fixed bottom-[calc(3.75rem+env(safe-area-inset-bottom))] left-1/2 z-[90] -translate-x-1/2 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-medium text-white lg:bottom-1"
      >
        UI v2 preview
      </div>
    </div>
  );
}
