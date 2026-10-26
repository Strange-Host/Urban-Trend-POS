// @vitest-environment-options {"url":"http://localhost:5173"}
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import client, { clearAccessToken } from '../api/client';
import { USE_NEW_SERVER } from '../api/newServer';
import { authApi } from '../api/endpoints';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ToastProvider, DialogProvider } from '../context/UIContext';
import ProtectedRoute from '../components/ProtectedRoute';
import Login from '../pages/Login';

// The UNMODIFIED legacy Login page, AuthContext, SessionGuard (lock screen) and ProtectedRoute, talking over real HTTP, from a
// different origin (http://localhost:5173 -> the API), to a really running new server. Nothing is mocked.
//
//   terminal 1 (server/):    npm run dev:stack
//   terminal 2 (frontend/):  npm run test:e2e-new-server
//
// Skipped in the normal test run, which has no server to talk to.
const ACCOUNTS = {
  admin: { email: 'admin@shop.test', password: 'Admin-Dev-Passphrase-1' },
  manager: { email: 'manager@shop.test', password: 'Manager-Dev-Passphrase-1' },
  cashier: { email: 'cashier@shop.test', password: 'Cashier-dev-1', pin: '4829' },
};

let auth;
function Probe() { auth = useAuth(); return null; }
function Home() { const { user } = useAuth(); return <div>HOME {user.name} ({user.role})</div>; }

function Harness({ at = '/' }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><DialogProvider>
        <AuthProvider>
          <Probe />
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
              <Route path="/payroll" element={<ProtectedRoute permission="payroll.view"><div>PAYROLL PAGE</div></ProtectedRoute>} />
              <Route path="/void" element={<ProtectedRoute permission="sales.void"><div>VOID PAGE</div></ProtectedRoute>} />
              <Route path="/admin" element={<ProtectedRoute roles={['admin']}><div>ADMIN PAGE</div></ProtectedRoute>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </DialogProvider></ToastProvider>
    </QueryClientProvider>
  );
}

const field = (type) => document.querySelector(`input[type="${type}"]`);
async function signInThroughTheForm(who, { remember = false } = {}) {
  await screen.findByText('Sign in', { selector: 'button, h1, h2, div' }).catch(() => null);
  await waitFor(() => expect(field('email')).toBeTruthy());
  fireEvent.change(field('email'), { target: { value: who.email } });
  fireEvent.change(field('password'), { target: { value: who.password } });
  if (remember) fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(document.querySelector('button[type="submit"]'));
}
/** A page reload: every in-memory thing goes (components, access token, tab storage); only the browser's cookies survive. */
async function reload(at = '/') {
  cleanup(); clearAccessToken(); localStorage.clear(); sessionStorage.clear();
  render(<Harness at={at} />);
}
const signOutAndForget = async () => { await act(async () => { await auth?.logout?.(); }); clearAccessToken(); cleanup(); };

describe.skipIf(!USE_NEW_SERVER)('the legacy screens against the real new server', () => {
  beforeAll(async () => {
    // A throwaway check that the server is really there, so a missing server fails loudly instead of as a pile of timeouts.
    const res = await client.get('/health').catch((e) => e);
    if (res?.response?.status === undefined && !res?.status) throw new Error(`The new server is not reachable (${res?.message}). Start it with: cd server && npm run dev:stack`);
  }, 20_000);
  afterEach(async () => { await signOutAndForget(); });

  it('sends a stranger to the login screen, without a flash of the page', async () => {
    render(<Harness at="/" />);
    await waitFor(() => expect(field('email')).toBeTruthy());
    expect(screen.queryByText(/HOME/)).not.toBeInTheDocument();
  });

  it('shows the server\'s own message for a wrong password, and for an unknown email the same one', async () => {
    render(<Harness at="/login" />);
    await signInThroughTheForm({ email: ACCOUNTS.manager.email, password: 'definitely-wrong-1' });
    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    fireEvent.change(field('email'), { target: { value: 'nobody@shop.test' } });
    fireEvent.click(document.querySelector('button[type="submit"]'));
    await waitFor(() => expect(screen.getAllByText('Wrong username or password.').length).toBe(1));
  });

  it('signs in through the real form, shows the person by name, and is still signed in after a reload (the refresh cookie works across origins)', async () => {
    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.manager);
    expect(await screen.findByText('HOME Manager (sample) (manager)')).toBeInTheDocument();
    expect(auth.user.permissions).toContain('reports.view');
    expect(auth.session.lockAfterSeconds).toBe(600);

    await reload('/');
    expect(await screen.findByText('HOME Manager (sample) (manager)')).toBeInTheDocument(); // no login screen: restored from the cookie alone
    expect(field('email')).toBeNull();
  }, 30_000);

  it('opens and closes pages by the Staff access keys and by role', async () => {
    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.manager);
    await screen.findByText(/HOME Manager/);
    expect(auth.can('payroll.view')).toBe(true);
    expect(auth.can('sales.void')).toBe(true);
    expect(auth.can('payroll.approve')).toBe(false);
    await reload('/payroll');
    expect(await screen.findByText('PAYROLL PAGE')).toBeInTheDocument();
    await reload('/admin');
    expect(await screen.findByText(/HOME Manager/)).toBeInTheDocument(); // a manager is bounced from an admin-only page
    await signOutAndForget();

    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.cashier);
    await screen.findByText(/HOME Cashier/);
    expect(auth.user.has_pin).toBe(true);
    await reload('/payroll');
    expect(await screen.findByText(/HOME Cashier/)).toBeInTheDocument(); // a cashier has no payroll.view
    await reload('/void');
    expect(await screen.findByText(/HOME Cashier/)).toBeInTheDocument();
  }, 40_000);

  it('locks the screen, and the real lock screen unlocks with the password (and a cashier with the PIN)', async () => {
    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.manager);
    await screen.findByText(/HOME Manager/);
    act(() => auth.lock());
    const input = await waitFor(() => { const i = document.getElementById('identity-secret'); expect(i).toBeTruthy(); return i; });
    fireEvent.change(input, { target: { value: 'wrong-wrong-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Unlock/ }));
    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
    fireEvent.change(document.getElementById('identity-secret'), { target: { value: ACCOUNTS.manager.password } });
    fireEvent.click(screen.getByRole('button', { name: /Unlock/ }));
    await waitFor(() => expect(document.getElementById('identity-secret')).toBeNull());
    await signOutAndForget();

    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.cashier);
    await screen.findByText(/HOME Cashier/);
    act(() => auth.lock());
    await waitFor(() => expect(document.getElementById('identity-secret')).toBeTruthy());
    expect(screen.getByText('Your PIN')).toBeInTheDocument(); // a cashier with a PIN is offered the PIN first
    fireEvent.change(document.getElementById('identity-secret'), { target: { value: ACCOUNTS.cashier.pin } });
    fireEvent.click(screen.getByRole('button', { name: /Unlock/ }));
    await waitFor(() => expect(document.getElementById('identity-secret')).toBeNull());
  }, 40_000);

  it('signing out ends the session for good: a reload goes to the login screen', async () => {
    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.manager);
    await screen.findByText(/HOME Manager/);
    await act(async () => { await auth.logout(); });
    await reload('/');
    await waitFor(() => expect(field('email')).toBeTruthy());
    expect(screen.queryByText(/HOME/)).not.toBeInTheDocument();
  }, 30_000);

  it('when the SERVER locks an idle session, the held request waits for the real lock screen and then carries on by itself', async () => {
    // An admin shortens the cashier lock time to its minimum (1 minute), so the server-side lock can be seen without a long wait.
    await authApi.login(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
    const put = await client.put('/security/policy', { roles: { cashier: { lockMinutes: 1, idleSignOutMinutes: 5, maxHours: 12 } } });
    expect(put.status).toBe(200);
    await authApi.logout(); clearAccessToken();

    render(<Harness at="/login" />);
    await signInThroughTheForm(ACCOUNTS.cashier);
    await screen.findByText(/HOME Cashier/);
    expect(auth.session.lockAfterSeconds).toBe(60);
    await new Promise((r) => setTimeout(r, 62_000)); // idle past the server's lock time (the screen's own timer locks it even earlier)

    const held = client.get('/orders'); // the server answers 403 SESSION_LOCKED; the client must hold it, not fail it
    const input = await waitFor(() => { const i = document.getElementById('identity-secret'); expect(i).toBeTruthy(); return i; }, { timeout: 10_000 });
    fireEvent.change(input, { target: { value: ACCOUNTS.cashier.pin } });
    fireEvent.click(screen.getByRole('button', { name: /Unlock/ }));
    const res = await held;
    expect(res.status).toBe(200); // repeated automatically after unlocking
    await waitFor(() => expect(document.getElementById('identity-secret')).toBeNull());

    await signOutAndForget();
    await authApi.login(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
    await client.put('/security/policy', { roles: { cashier: { lockMinutes: 5, idleSignOutMinutes: 30, maxHours: 12 } } }); // put it back
    await authApi.logout(); clearAccessToken();
  }, 120_000);
});
