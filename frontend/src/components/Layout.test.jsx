import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Layout from './Layout';

const auth = { role: 'admin' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Ann Admin', role: auth.role },
    logout: vi.fn(), lock: vi.fn(),
    hasRole: (...roles) => roles.includes(auth.role),
    can: (perm) => auth.role === 'admin' || perm === 'none',
  }),
}));
vi.mock('../hooks/useModules', () => ({ default: () => ({ hr: true, control: true, loaded: true }) }));
vi.mock('../hooks/useSlidingPill', () => ({ default: () => ({ rootRef: { current: null }, pillProps: {} }) }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('./useStackedTableLabels', () => ({ default: () => {} }));

function mount() {
  return render(
    <MemoryRouter initialEntries={['/orders']}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/orders" element={<div>Orders page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { localStorage.clear(); auth.role = 'admin'; });

describe('Layout sidebar modes', () => {
  it('starts expanded with the wide sidebar and the dock controls', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Icons only' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shrinks to the icon rail, remembers it, and expands again', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Icons only' }));
    expect(localStorage.getItem('ut_sidebar_mode')).toBe('rail');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(localStorage.getItem('ut_sidebar_mode')).toBe('expanded');
  });

  it('shows a tooltip with the page name when an icon is hovered in the rail', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Icons only' }));
    await user.hover(screen.getByRole('link', { name: 'Orders' }));
    expect(screen.getByRole('tooltip').textContent).toBe('Orders');
    await user.unhover(screen.getByRole('link', { name: 'Orders' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('hides completely and can be pinned back from the slide-in drawer', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(localStorage.getItem('ut_sidebar_mode')).toBe('hidden');
    await user.click(screen.getByRole('button', { name: 'Pin sidebar' }));
    expect(localStorage.getItem('ut_sidebar_mode')).toBe('expanded');
  });

  it('migrates the first version of the hide toggle', () => {
    localStorage.setItem('ut_sidebar_hidden', '1');
    mount();
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toBeTruthy();
  });

  it('opens the account menu with security, lock and sign out', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.getByRole('menuitem', { name: /Security & devices/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Lock screen/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Sign out/ })).toBeTruthy();
  });

  it('opens the go-to palette with Ctrl+K', () => {
    mount();
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Go to' })).toBeTruthy();
  });

  it('shows group headings to a role with many pages and a plain list to one with few', () => {
    mount();
    expect(screen.getByRole('button', { name: /^Sell/ })).toBeTruthy();
  });

  it('drops the group headings for a role that sees only a few pages', () => {
    auth.role = 'cashier';
    mount();
    expect(screen.queryByRole('button', { name: /^Sell/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Orders' })).toBeTruthy();
  });
});
