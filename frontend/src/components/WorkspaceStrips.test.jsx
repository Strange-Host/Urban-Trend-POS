import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Layout from './Layout';
import { storesApi, cashSessionsApi } from '../api/endpoints';
import { ALL_ITEMS, filterVisible } from './navItems';
import { buildRail } from './shell/railModel';
import { canFor, hasRoleFor } from './shell/testRoles';

// Redesign Phase 6: Sell, Money and Team are workspaces whose pages are tabs over their existing routes. The shell draws the strip
// (a page with a PageHeader draws it under its title instead, covered in Layout.test.jsx), so this walks every page of those
// workspaces, for every role that has a workspace rail, through the real shell with a bare page in the outlet.

const auth = { role: 'admin' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Pat', role: auth.role }, logout: vi.fn(), lock: vi.fn(),
    hasRole: hasRoleFor(auth.role), can: canFor(auth.role),
  }),
}));
vi.mock('../hooks/useModules', () => ({ default: () => ({ hr: true, control: true, branches: true, loaded: true }) }));
vi.mock('./NotificationBell', () => ({ default: () => <button type="button" aria-label="Notifications" /> }));
vi.mock('./useStackedTableLabels', () => ({ default: () => {} }));
vi.mock('../api/endpoints', () => ({ storesApi: { list: vi.fn() }, cashSessionsApi: { current: vi.fn() } }));

const STRIP = { name: 'Pages in this workspace' };
const MODULES = { hr: true, control: true };

function mount(path) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route element={<Layout />}><Route path="*" element={<div>The page</div>} /></Route></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const railFor = (role) => buildRail(filterVisible(ALL_ITEMS, { hasRole: hasRoleFor(role), can: canFor(role), modules: MODULES }));

beforeEach(() => {
  localStorage.clear();
  storesApi.list.mockResolvedValue({ data: { data: [{ id: 1, name: 'Main Branch', is_current: 1 }] } });
  cashSessionsApi.current.mockResolvedValue({ data: { data: null } });
});

for (const role of ['admin', 'manager']) {
  const walk = railFor(role).entries
    .filter((e) => ['sell', 'money', 'team'].includes(e.id))
    .flatMap((ws) => ws.pages.map((page) => [`${ws.label} > ${page.label}`, ws, page]));

  describe(`${role}: every Sell, Money and Team page shows its workspace strip`, () => {
    it('has pages to walk', () => expect(walk.length).toBeGreaterThanOrEqual(role === 'admin' ? 15 : 12));

    it.each(walk)('%s', (_name, ws, page) => {
      auth.role = role;
      mount(page.to);
      const strips = screen.getAllByRole('navigation', STRIP);
      expect(strips).toHaveLength(1); // one strip: not none, not a second copy
      const tabs = within(strips[0]);
      expect(tabs.getAllByRole('link').map((a) => a.textContent)).toEqual(ws.pages.map((p) => p.label));
      const current = tabs.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current.map((a) => a.textContent)).toEqual([page.label]); // exactly this page, no neighbour with a look-alike path
      expect(within(screen.getByRole('navigation', { name: 'Workspaces' })).getByRole('link', { name: ws.label }).getAttribute('aria-current')).toBe('page');
    });
  });
}

describe('sub-pages and the other roles', () => {
  it('keeps Attendance marked on End of day, a page beneath it', () => {
    auth.role = 'admin';
    mount('/attendance/end-of-day');
    const current = within(screen.getByRole('navigation', STRIP)).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Attendance']);
  });

  it('does not light Staff on Activity log, whose path starts the same way', () => {
    auth.role = 'admin';
    mount('/staff-logs');
    const current = within(screen.getByRole('navigation', STRIP)).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Activity log']);
  });

  it.each([
    ['cashier', ['/start', '/orders', '/leads', '/sales', '/approvals', '/requisitions', '/attendance']],
    ['store', ['/catalog', '/stock']],
  ])('%s has a flat rail and no strip on any of their pages', (role, paths) => {
    auth.role = role;
    for (const path of paths) {
      const { unmount } = mount(path);
      expect(screen.queryByRole('navigation', STRIP), path).toBeNull();
      unmount();
    }
  });
});
