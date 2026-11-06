import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import UserMenu from './UserMenu';
import { getUiVersion, setUiVersion } from '../utils/uiVersion';
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

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); setCashierHome('start'); auth.role = 'admin'; });

describe('UserMenu layout switch', () => {
  it('lets an admin try the new layout, and remembers it', async () => {
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Try new layout' }));
    expect(getUiVersion()).toBe('v2');
  });

  it('lets an admin go back to the current layout', async () => {
    setUiVersion('v2');
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Use current layout' }));
    expect(getUiVersion()).toBe('v1');
  });

  it('is not offered to managers, cashiers or storekeepers', async () => {
    for (const role of ['manager', 'cashier', 'store']) {
      auth.role = role;
      document.body.innerHTML = '';
      await openMenu();
      expect(screen.queryByRole('menuitem', { name: /layout/i })).toBeNull();
      expect(screen.getByRole('menuitem', { name: /lock screen/i })).toBeTruthy();
    }
  });
});

describe('UserMenu cashier home', () => {
  it('lets a cashier on the new layout open on the till, and back to the Start screen', async () => {
    auth.role = 'cashier';
    setUiVersion('v2');
    let user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Open on the till' }));
    expect(getCashierHome()).toBe('till');

    document.body.innerHTML = '';
    user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Open on the Start screen' }));
    expect(getCashierHome()).toBe('start');
  });

  it('is not offered on the current layout, or to anyone but cashiers', async () => {
    auth.role = 'cashier';
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /Open on the/ })).toBeNull();

    setUiVersion('v2');
    for (const role of ['admin', 'manager', 'store']) {
      auth.role = role;
      document.body.innerHTML = '';
      await openMenu();
      expect(screen.queryByRole('menuitem', { name: /Open on the/ })).toBeNull();
    }
  });
});
