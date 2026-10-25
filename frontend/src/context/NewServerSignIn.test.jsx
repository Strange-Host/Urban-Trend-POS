import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import axios from 'axios';
import client from '../api/client';
import { AuthProvider, useAuth } from './AuthContext';
import login from '../api/adapters/__fixtures__/auth-login.json';

// The real, unmodified AuthContext, with the auth calls going through the new-server adapter and the answers being the
// recorded ones from the real new server.
vi.mock('../api/endpoints', async () => ({ authApi: (await import('../api/adapters/auth')).newAuthApi }));

let auth;
function Probe() {
  auth = useAuth();
  return <div data-testid="state">{auth.initializing ? 'booting' : auth.user ? `in:${auth.user.name}:${auth.user.role}` : 'out'}</div>;
}
afterEach(() => { vi.restoreAllMocks(); });

describe('legacy sign-in against the new server\'s answers', () => {
  it('signs in, shows the person by name, and answers the screens\' permission questions from the Staff access keys', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 401, data: { error: { code: 'REFRESH_REQUIRED', message: 'x' } } } }); // no cookie yet
    vi.spyOn(client, 'post').mockResolvedValue({ data: login });
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('state')).toHaveTextContent('out');

    await act(async () => { await auth.login('fixture@shop.test', 'pw', true); });
    expect(screen.getByTestId('state')).toHaveTextContent('in:Fixture Manager:manager');
    expect(auth.can('reports.view')).toBe(true);
    expect(auth.can('sales.void')).toBe(true);
    expect(auth.can('payroll.approve')).toBe(false); // not a delegable key: the UI never offers it to a manager
    expect(auth.hasRole('manager')).toBe(true);
  });
});
