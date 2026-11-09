import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import UserMenu from './UserMenu';
import { getCashierHome, setCashierHome } from '../utils/cashierHome';

const auth = { role: 'admin' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Ann Admin', role: auth.role }, logout: vi.fn(), lock: vi.fn() }),
}));
vi.mock('./ThemeSwitch', () => ({ default: () => null }));

async function openMenu() {
  const user = userEvent.setup();
  render(<MemoryRouter><UserMenu /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: /account menu/i }));
  return user;
}

beforeEach(() => { localStorage.clear(); setCashierHome('start'); auth.role = 'admin'; });

describe('UserMenu', () => {
  it('offers security, lock and sign out to everyone, and no layout switch (the new layout is the only one)', async () => {
    for (const role of ['admin', 'manager', 'cashier', 'store']) {
      auth.role = role;
      document.body.innerHTML = '';
      await openMenu();
      expect(screen.queryByRole('menuitem', { name: /layout/i })).toBeNull();
      expect(screen.getByRole('menuitem', { name: /security/i })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: /lock screen/i })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeTruthy();
    }
  });
});

describe('UserMenu cashier home', () => {
  it('lets a cashier open on the till, and back to the Start screen', async () => {
    auth.role = 'cashier';
    let user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Open on the till' }));
    expect(getCashierHome()).toBe('till');

    document.body.innerHTML = '';
    user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Open on the Start screen' }));
    expect(getCashierHome()).toBe('start');
  });

  it('is not offered to anyone but cashiers', async () => {
    for (const role of ['admin', 'manager', 'store']) {
      auth.role = role;
      document.body.innerHTML = '';
      await openMenu();
      expect(screen.queryByRole('menuitem', { name: /Open on the/ })).toBeNull();
    }
  });
});
