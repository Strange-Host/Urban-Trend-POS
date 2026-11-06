import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import { setUiVersion } from '../utils/uiVersion';
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

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); setCashierHome('start'); auth.role = 'cashier'; });

describe('Home', () => {
  it('opens a cashier on the till with the current layout, as it always has', () => {
    renderHome();
    expect(screen.getByText('THE TILL')).toBeInTheDocument();
  });

  it('sends a cashier to the Start screen (/start) with the new layout', async () => {
    setUiVersion('v2');
    renderHome();
    expect(await screen.findByText('THE START SCREEN')).toBeInTheDocument();
  });

  it('opens a cashier on the till with the new layout when they chose that', () => {
    setUiVersion('v2');
    setCashierHome('till');
    renderHome();
    expect(screen.getByText('THE TILL')).toBeInTheDocument();
  });

  it('leaves the other roles where they were, with either layout', async () => {
    for (const v of ['v1', 'v2']) {
      setUiVersion(v);
      auth.role = 'manager';
      const { unmount } = renderHome();
      expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
      unmount();
      auth.role = 'store';
      const second = renderHome();
      expect(await screen.findByText('CATALOG')).toBeInTheDocument();
      second.unmount();
    }
  });
});
