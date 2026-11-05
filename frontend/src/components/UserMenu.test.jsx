import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import UserMenu from './UserMenu';
import { getUiVersion, setUiVersion } from '../utils/uiVersion';

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

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); auth.role = 'admin'; });

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
