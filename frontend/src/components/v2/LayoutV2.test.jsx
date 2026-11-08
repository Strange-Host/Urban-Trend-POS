import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LayoutV2 from './LayoutV2';
import { storesApi, cashSessionsApi } from '../../api/endpoints';
import { canFor, hasRoleFor } from '../shell/testRoles';
import PageHeader from '../shell/PageHeader';
import PageSection from '../shell/PageSection';
import { setUiVersion } from '../../utils/uiVersion';

const auth = { role: 'admin' };
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Ann Admin', role: auth.role },
    logout: vi.fn(), lock: vi.fn(),
    hasRole: hasRoleFor(auth.role),
    can: canFor(auth.role),
  }),
}));
vi.mock('../../hooks/useModules', () => ({ default: () => ({ hr: true, control: true, loaded: true }) }));
vi.mock('../NotificationBell', () => ({ default: () => <button type="button" aria-label="Notifications" /> }));
vi.mock('../useStackedTableLabels', () => ({ default: () => {} }));
vi.mock('../../api/endpoints', () => ({
  storesApi: { list: vi.fn() },
  cashSessionsApi: { current: vi.fn() },
}));

function mount(path = '/orders', page = <div>The page</div>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<LayoutV2 />}>
            <Route path="*" element={page} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
// jsdom matches no media query, so the shell renders its small-screen form. Wide tests pretend the viewport is lg+.
const realMatchMedia = window.matchMedia;
const setWide = (wide) => {
  window.matchMedia = (q) => ({ matches: wide && q.includes('min-width: 1024px'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
};
afterEach(() => { window.matchMedia = realMatchMedia; });
const topBar = () => within(screen.getByRole('banner'));
const rail = () => within(screen.getByRole('navigation', { name: 'Workspaces' }));
const labels = (nav) => nav.getAllByRole('link').map((a) => a.textContent);

beforeEach(() => {
  localStorage.clear();
  auth.role = 'admin';
  storesApi.list.mockResolvedValue({ data: { data: [{ id: 1, name: 'Main Branch', is_current: 1 }, { id: 2, name: 'Westlands', is_current: 0 }] } });
  cashSessionsApi.current.mockResolvedValue({ data: { data: null } });
});

describe('the rail, per role', () => {
  it('admin: five workspaces; Search, Alerts and Settings are not in the rail (they are in the top bar)', () => {
    mount();
    expect(labels(rail())).toEqual(['Today', 'Sell', 'Stock', 'Money', 'Team']);
    const aside = within(screen.getByRole('complementary', { name: 'Main navigation' }));
    expect(aside.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(aside.queryByRole('button', { name: 'Search pages' })).toBeNull();
    expect(aside.queryByRole('button', { name: 'Notifications' })).toBeNull();
    expect(aside.getByRole('button', { name: /account menu/i })).toBeTruthy();
  });

  it('manager: the same five workspaces, no Settings', () => {
    auth.role = 'manager';
    setWide(true);
    mount();
    expect(labels(rail())).toEqual(['Today', 'Sell', 'Stock', 'Money', 'Team']);
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('cashier: a flat rail with Start first and Shift last', () => {
    auth.role = 'cashier';
    mount('/orders');
    expect(labels(rail())).toEqual(['Start', 'Terminal', 'Orders', 'Leads', 'Sales history', 'Approvals', 'Requisitions', 'Attendance', 'Shift']);
    expect(rail().getByRole('link', { name: 'Shift' }).getAttribute('href')).toBe('/terminal?shift=close');
    expect(screen.getByRole('link', { name: 'Urban Trends, home' }).getAttribute('href')).toBe('/start');
  });

  it('cashier at the till: Exit till, Sell, Orders and Approvals, and Exit goes to Start', () => {
    auth.role = 'cashier';
    mount('/terminal');
    expect(labels(rail())).toEqual(['Exit till', 'Terminal', 'Orders', 'Approvals']);
    expect(rail().getByRole('link', { name: 'Exit till' }).getAttribute('href')).toBe('/start');
    expect(rail().getByRole('link', { name: 'Terminal' }).getAttribute('aria-current')).toBe('page');
  });

  it('manager at the till keeps the full workspace rail', () => {
    auth.role = 'manager';
    mount('/terminal');
    expect(labels(rail())).toEqual(['Today', 'Sell', 'Stock', 'Money', 'Team']);
  });

  it('storekeeper: a flat rail of two, and the logo goes to the catalog', () => {
    auth.role = 'store';
    mount('/catalog');
    expect(labels(rail())).toEqual(['Catalog', 'Stock control']);
    expect(screen.getByRole('link', { name: 'Urban Trends, home' }).getAttribute('href')).toBe('/catalog');
  });

  it('each workspace item goes to its first page', () => {
    mount();
    const href = (name) => rail().getByRole('link', { name }).getAttribute('href');
    expect([href('Today'), href('Sell'), href('Stock'), href('Money'), href('Team')])
      .toEqual(['/dashboard', '/terminal', '/catalog', '/finance', '/attendance']);
  });
});

describe('where you are', () => {
  it('marks the current workspace, including for sub-pages', () => {
    mount('/attendance/end-of-day');
    expect(rail().getByRole('link', { name: 'Team' }).getAttribute('aria-current')).toBe('page');
    expect(rail().getByRole('link', { name: 'Sell' }).getAttribute('aria-current')).toBeNull();
  });

  it('shows the workspace pages as links, with the current one marked', () => {
    mount('/orders');
    const tabs = within(screen.getByRole('navigation', { name: 'Pages in this workspace' }));
    expect(labels(tabs)).toEqual(['Terminal', 'Orders', 'Leads', 'Sales history', 'Approvals']);
    expect(tabs.getByRole('link', { name: 'Orders' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows no tab strip on the flat rail, or on a page outside the navigation', () => {
    auth.role = 'cashier';
    const { unmount } = mount('/orders');
    expect(screen.queryByRole('navigation', { name: 'Pages in this workspace' })).toBeNull();
    unmount();
    auth.role = 'admin';
    mount('/security');
    expect(screen.queryByRole('navigation', { name: 'Pages in this workspace' })).toBeNull();
    expect(rail().getAllByRole('link').every((a) => a.getAttribute('aria-current') === null)).toBe(true);
  });

  it('renders the page in the outlet and the preview marker', () => {
    mount();
    expect(screen.getByText('The page')).toBeTruthy();
    expect(screen.getByTestId('ui-v2-marker')).toBeTruthy();
  });
});

describe('search', () => {
  it('opens from the Search button and from Ctrl+K', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull();
    setWide(true);
    cleanup();
    mount();
    await user.click(topBar().getByRole('button', { name: 'Search pages' }));
    expect(screen.getByRole('dialog', { name: 'Go to' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Go to' })).toBeTruthy();
  });
});

describe('top bar (large screens)', () => {
  beforeEach(() => setWide(true));

  it('holds Search, Alerts and Settings on the right, and Settings goes to /settings', () => {
    mount();
    expect(topBar().getByRole('button', { name: 'Search pages' })).toBeTruthy();
    expect(topBar().getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(topBar().getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
  });

  it('marks Settings as current on the settings page', () => {
    mount('/settings');
    expect(topBar().getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
  });

  it('carries the one status line, so a page header does not draw a second', async () => {
    mount('/orders', <PageHeader title="Orders" description="All orders." />);
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
    await waitFor(() => expect(topBar().getByText('Main Branch')).toBeTruthy());
    expect(topBar().getByLabelText('Status')).toBeTruthy();
  });

  it('still shows the workspace tabs under the title', () => {
    mount('/orders', <PageHeader title="Orders" />);
    expect(screen.getAllByRole('navigation', { name: 'Pages in this workspace' })).toHaveLength(1);
  });

  it('has no top bar on small screens', () => {
    setWide(false);
    mount();
    expect(screen.queryByRole('banner')).toBeNull();
  });
});

describe('status line', () => {
  const status = () => within(screen.getByLabelText('Status'));

  it('shows the branch, the connection and the shift', async () => {
    mount();
    await waitFor(() => expect(status().getByText('Main Branch')).toBeTruthy());
    expect(status().getByText('Online')).toBeTruthy();
    await waitFor(() => expect(status().getByText('No shift open')).toBeTruthy());
  });

  it('says when a shift is open', async () => {
    cashSessionsApi.current.mockResolvedValue({ data: { data: { id: 7, opened_at: '2026-11-05T08:12:00', opening_amount: 500000 } } });
    mount();
    await waitFor(() => expect(status().getByText(/^Shift open since/)).toBeTruthy());
  });

  it('leaves the shift out for a storekeeper, who has no till', async () => {
    auth.role = 'store';
    mount('/catalog');
    await waitFor(() => expect(status().getByText('Main Branch')).toBeTruthy());
    expect(cashSessionsApi.current).not.toHaveBeenCalled();
    expect(status().queryByText(/shift/i)).toBeNull();
  });

  it('quietly leaves a part out when its lookup fails', async () => {
    storesApi.list.mockRejectedValue(new Error('nope'));
    cashSessionsApi.current.mockRejectedValue(new Error('nope'));
    mount();
    await waitFor(() => expect(storesApi.list).toHaveBeenCalled());
    expect(status().getByText('Online')).toBeTruthy();
    expect(status().queryByText('Main Branch')).toBeNull();
    expect(status().queryByText(/shift/i)).toBeNull();
  });
});

describe('phone bottom bar', () => {
  const bar = () => within(screen.getByRole('navigation', { name: 'Mobile navigation' }));

  it('shows four destinations and More, and the rest sits behind More', async () => {
    const user = userEvent.setup();
    mount('/orders');
    expect(labels(bar())).toEqual(['Today', 'Sell', 'Stock', 'Money']);
    expect(bar().getByRole('link', { name: 'Sell' }).getAttribute('aria-current')).toBe('page');
    await user.click(bar().getByRole('button', { name: 'More' }));
    const more = within(screen.getByRole('dialog', { name: 'More' }));
    expect(more.getByRole('link', { name: 'Team' })).toBeTruthy();
    expect(more.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(more.getByRole('button', { name: 'Search pages' })).toBeTruthy();
    expect(more.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(more.getByRole('button', { name: /account menu/i })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
  });

  it('keeps the account menu reachable for a small role', async () => {
    const user = userEvent.setup();
    auth.role = 'store';
    mount('/catalog');
    expect(labels(bar())).toEqual(['Catalog', 'Stock control']);
    await user.click(bar().getByRole('button', { name: 'More' }));
    await user.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: /account menu/i }));
    expect(screen.getByRole('menuitem', { name: /lock screen/i })).toBeTruthy();
  });

  it('lights More when the current page is behind it', () => {
    mount('/staff');
    expect(bar().getByRole('button', { name: 'More' }).className).toContain('text-accent');
  });
});

describe('who draws the status line and workspace tabs', () => {
  beforeEach(() => setUiVersion('v2'));
  const tabsNav = () => screen.queryAllByRole('navigation', { name: 'Pages in this workspace' });

  it('the shell draws them above a page that has no header of its own (the till)', () => {
    mount('/terminal', <div>The till</div>);
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
    expect(tabsNav()).toHaveLength(1);
  });

  it('a page with a PageHeader draws them itself, under its title, and the shell steps back', () => {
    mount('/orders', <PageHeader title="Orders" description="All orders." />);
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
    expect(tabsNav()).toHaveLength(1);
    const heading = screen.getByRole('heading', { level: 1, name: 'Orders' });
    expect(heading.compareDocumentPosition(screen.getByLabelText('Status')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(tabsNav()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an embedded page does not draw a second copy', () => {
    mount('/finance', (
      <>
        <PageHeader title="Finance" titleless tabs={{ items: [{ key: 'p', label: 'Payments' }], active: 'p', onChange: () => {} }} />
        <PageSection><PageHeader title="Payments" description="Money in and out." /></PageSection>
      </>
    ));
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Finance']);
  });

  it('hands the chrome back to the shell when the page with a header goes away', () => {
    const { unmount } = mount('/orders', <PageHeader title="Orders" />);
    unmount();
    mount('/terminal', <div>The till</div>);
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
  });
});
