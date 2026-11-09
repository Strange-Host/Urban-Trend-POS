import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import { setCashierHome } from '../utils/cashierHome';
import { canFor } from './shell/testRoles';

const auth = { role: 'cashier' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Pat', role: auth.role }, can: canFor(auth.role) }),
}));
vi.mock('../pages/POSTerminal', () => ({ default: () => <div>THE TILL</div> }));

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/start" element={<div>THE START SCREEN</div>} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/catalog" element={<div>CATALOG</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { localStorage.clear(); setCashierHome('start'); auth.role = 'cashier'; });

describe('Home', () => {
  it('sends a cashier to the Start screen (/start)', async () => {
    renderHome();
    expect(await screen.findByText('THE START SCREEN')).toBeInTheDocument();
  });

  it('opens a cashier on the till when they chose that', () => {
    setCashierHome('till');
    renderHome();
    expect(screen.getByText('THE TILL')).toBeInTheDocument();
  });

  it('leaves the other roles where they were', async () => {
    auth.role = 'manager';
    const { unmount } = renderHome();
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
    unmount();
    auth.role = 'store';
    renderHome();
    expect(await screen.findByText('CATALOG')).toBeInTheDocument();
  });
});
