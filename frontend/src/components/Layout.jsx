import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import useStackedTableLabels from './useStackedTableLabels';
import useModules from '../hooks/useModules';

// Grouped by "what am I doing right now", not by which backend module a
// page belongs to — that's why Attendance sits under Team next to Payroll
// (attendance data is literally what drives payroll deductions) rather
// than under an Operations bucket, and why Reconciliation sits under Money
// next to Finance rather than next to Orders.
//
// Terminal and Dashboard are deliberately ungrouped and pinned to the top:
// they're where a shift starts, and burying either one behind a disclosure
// triangle to save two lines would be a bad trade.
const PINNED_TOP = [
  { to: '/', label: 'Terminal', icon: '⌸', roles: ['admin', 'manager', 'cashier'] },
  { to: '/dashboard', label: 'Dashboard', icon: '▲', roles: ['admin', 'manager'], perm: 'reports.view' },
];

const GROUPS = [
  {
    id: 'sell',
    label: 'Sell',
    items: [
      { to: '/orders', label: 'Orders', icon: '⊞', roles: ['admin', 'manager', 'cashier'] },
      { to: '/leads', label: 'Leads', icon: '☍', roles: ['admin', 'manager', 'cashier'] },
      { to: '/sales', label: 'Sales history', icon: '𝍖', roles: ['admin', 'manager', 'cashier'] },
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    items: [
      { to: '/catalog', label: 'Catalog', icon: '▤', roles: ['admin', 'manager'], perm: 'products.manage' },
      { to: '/shopify-sync', label: 'Shopify sync', icon: '⇄', roles: ['admin', 'manager'], perm: 'shopify.sync' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { to: '/finance', label: 'Finance', icon: '◈', roles: ['admin', 'manager'] },
      { to: '/reconciliation', label: 'Reconciliation', icon: '⇌', roles: ['admin', 'manager'], perm: 'payments.reconcile' },
      { to: '/requisitions', label: 'Requisitions', icon: '⇵', roles: ['admin', 'manager', 'cashier'], module: 'hr' },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    items: [
      { to: '/attendance', label: 'Attendance', icon: '◷', roles: ['admin', 'manager', 'cashier'], module: 'hr' },
      { to: '/payroll', label: 'Payroll', icon: '⊟', roles: ['admin', 'manager'], perm: 'payroll.view', module: 'hr' },
      { to: '/staff', label: 'Staff', icon: '☺', roles: ['admin'] },
      { to: '/employees', label: 'Onboarding', icon: '✎', roles: ['admin'], module: 'hr' },
      { to: '/staff-logs', label: 'Activity log', icon: '☰', roles: ['admin'] },
    ],
  },
];

const PINNED_BOTTOM = [
  { to: '/settings', label: 'Settings', icon: '⚙', roles: ['admin'] },
];

const COLLAPSE_KEY = 'ut_nav_collapsed';

function NavItem({ item, onNavigate, nested = false }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg text-sm transition-colors ${nested ? 'pl-8 pr-3 py-2' : 'px-3 py-2.5 font-medium'} ${
          isActive
            ? 'bg-accent text-accent-ink font-medium'
            : 'text-white/70 hover:bg-white/10 hover:text-white'
        }`
      }
    >
      <span className="text-base leading-none w-4 shrink-0">{item.icon}</span>
      {item.label}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout, hasRole, can } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef(null);
  useStackedTableLabels(mainRef);
  const modules = useModules();

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
  const visible = (items) => items
    .filter((i) => !i.module || modules[i.module])
    .filter((i) => (i.perm ? can(i.perm) : hasRole(...i.roles)));
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

  const closeNav = () => setNavOpen(false);

  return (
    <div className="flex h-dvh bg-paper text-text">
      {/* Top bar for phones and tablets — hidden lg+, where the persistent sidebar takes over */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-30 h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] bg-ink text-white flex items-center justify-between px-4">
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation menu"
          className="p-2 -ml-2 text-white/80 hover:text-white"
        >
          <span className="text-xl leading-none">☰</span>
        </button>
        <div className="font-display font-700 text-sm tracking-tight">Urban Trends</div>
        <NotificationBell className="-mr-2" />
      </div>

      {navOpen && (
        <button
          aria-label="Close navigation menu"
          onClick={closeNav}
          className="lg:hidden fixed inset-0 z-40 bg-black/40"
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-64 shrink-0 bg-ink text-white flex flex-col
          transform transition-transform duration-200 ease-out
          lg:static lg:z-auto lg:w-60 lg:translate-x-0
          ${navOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="px-5 py-6 border-b border-white/10 flex items-center justify-between">
          <div>
            <div className="font-display font-700 text-lg tracking-tight text-white">Urban Trends</div>
            <div className="text-xs text-white/50 font-mono mt-0.5">Main Branch</div>
          </div>
          <button
            onClick={closeNav}
            aria-label="Close navigation menu"
            className="lg:hidden p-2 -mr-2 text-white/60 hover:text-white"
          >
            ✕
          </button>
          <NotificationBell className="hidden lg:block -mr-2" />
        </div>

        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          <div className="space-y-1">
            {visible(PINNED_TOP).map((item) => (
              <NavItem key={item.to} item={item} onNavigate={closeNav} />
            ))}
          </div>

          {GROUPS.map((group) => {
            const items = visible(group.items);
            if (items.length === 0) return null; // whole group hidden by role — don't render an empty header
            // The group holding the current page is always open regardless of
            // saved state: landing somewhere with no highlighted nav item
            // anywhere in view would be disorienting.
            const isOpen = !collapsed.has(group.id) || activeGroupId === group.id;

            return (
              <div key={group.id} className="mt-5">
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center justify-between px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
                  aria-expanded={isOpen}
                >
                  {group.label}
                  <span className="text-[9px] leading-none">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div className="mt-1 space-y-0.5">
                    {items.map((item) => (
                      <NavItem key={item.to} item={item} onNavigate={closeNav} nested />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {visible(PINNED_BOTTOM).length > 0 && (
            <div className="mt-5 pt-4 border-t border-white/10 space-y-1">
              {visible(PINNED_BOTTOM).map((item) => (
                <NavItem key={item.to} item={item} onNavigate={closeNav} />
              ))}
            </div>
          )}
        </nav>

        <div className="px-3 py-4 border-t border-white/10">
          <div className="px-3 py-2">
            <div className="text-sm font-medium text-white">{user?.name}</div>
            <div className="text-xs text-white/50 capitalize">{user?.role}</div>
          </div>
          <button
            onClick={logout}
            className="w-full text-left px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto pt-[calc(3.5rem+env(safe-area-inset-top))] lg:pt-0">
        <Outlet />
      </main>
    </div>
  );
}
