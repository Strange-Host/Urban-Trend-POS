import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import axios from 'axios';
import client from '../api/client';
import { AuthProvider, useAuth } from './AuthContext';
import { authApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  authApi: {
    login: vi.fn(), verifyOtp: vi.fn(), unlock: vi.fn(), activity: vi.fn(), logout: vi.fn(),
  },
}));

const NOW = new Date('2026-10-20T10:00:00Z');
const session = (extra = {}) => ({
  id: 7, remember: false, lockAfterSeconds: 300, signOutAfterSeconds: 1800, reauthMinutes: 5,
  expiresAt: new Date(NOW.getTime() + 12 * 3600e3).toISOString(), lastActivityAt: NOW.toISOString(), idleSeconds: 0, ...extra,
});
const manager = { id: 2, name: 'Mary Manager', role: 'manager', has_pin: false, permissions: [] };
const cashier = { id: 3, name: 'Carl Cashier', role: 'cashier', has_pin: true, two_factor_enabled: 0, permissions: [] };

let auth;
function Probe() {
  auth = useAuth();
  return <div data-testid="state">{auth.initializing ? 'booting' : auth.user ? `in:${auth.user.name}${auth.locked ? ':locked' : ''}` : 'out'}</div>;
}
async function mount() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { await Promise.resolve(); });
}
const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });   // findBy* polls with real timers; these tests use fake ones
const advance = (seconds) => act(async () => { vi.advanceTimersByTime(seconds * 1000); });
const refreshFails = (code) => vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 401, data: { error: { code, message: 'x' } } } });
async function signIn(user = manager, sess = session()) {
  authApi.login.mockResolvedValue({ data: { token: 'tok-1', user, session: sess } });
  await act(async () => { await auth.login('a@b.co', 'pw'); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.values(authApi).forEach((f) => f.mockReset());
  authApi.activity.mockResolvedValue({ data: { ok: true } });
  authApi.logout.mockResolvedValue({ data: {} });
  authApi.unlock.mockResolvedValue({ data: { ok: true, session: session() } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); client.defaults.adapter = undefined; });

describe('signing in and the idle lock', () => {
  it('starts signed out when there is no valid session cookie', async () => {
    refreshFails('SESSION_EXPIRED');
    await mount();
    expect(screen.getByTestId('state')).toHaveTextContent('out');
    expect(sessionStorage.getItem('ut_flash')).toMatch(/session ended/i);
  });

  it('comes back locked after a reload if the server says it was idle past the lock time', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: manager, session: session({ idleSeconds: 400 }) } });
    await mount();
    expect(screen.getByTestId('state')).toHaveTextContent('in:Mary Manager:locked');
    expect(screen.getByRole('dialog', { name: /screen locked/i })).toBeInTheDocument();
  });

  it('warns, then locks the screen when nobody uses it, and unlocks with the password', async () => {
    refreshFails();
    await mount();
    await signIn();
    expect(screen.getByTestId('state')).toHaveTextContent('in:Mary Manager');

    await advance(260);                                   // lock is at 285 s: warning appears 30 s before
    expect(screen.getByText(/screen locks in/i)).toBeInTheDocument();

    await advance(30);
    expect(screen.getByRole('dialog', { name: /screen locked/i })).toBeInTheDocument();
    expect(screen.getByTestId('state')).toHaveTextContent(':locked');

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'my-password' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlock' })); });
    expect(authApi.unlock).toHaveBeenCalledWith({ password: 'my-password' });
    expect(screen.queryByRole('dialog', { name: /screen locked/i })).toBeNull();
    expect(screen.getByTestId('state')).not.toHaveTextContent('locked');
  });

  it('"Stay" on the warning keeps the screen unlocked', async () => {
    refreshFails();
    await mount();
    await signIn();
    await advance(265);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stay' })); });
    await advance(100);
    expect(screen.queryByRole('dialog', { name: /screen locked/i })).toBeNull();
  });

  it('real use (a tap) resets the idle clock and tells the server, at most every 30 seconds', async () => {
    refreshFails();
    await mount();
    await signIn();
    await advance(31);
    await act(async () => { fireEvent.pointerDown(document.body); });
    expect(authApi.activity).toHaveBeenCalledTimes(1);
    await advance(5);
    await act(async () => { fireEvent.pointerDown(document.body); });
    expect(authApi.activity).toHaveBeenCalledTimes(1);     // throttled
    await advance(280);                                    // would have locked without the tap, but the tap was 285 s ago
    expect(screen.queryByRole('dialog', { name: /screen locked/i })).toBeNull();
  });

  it('shows the server\'s message when the password is wrong and stays locked', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: manager, session: session({ idleSeconds: 999 }) } });
    await mount();
    authApi.unlock.mockRejectedValue({ response: { status: 401, data: { error: { code: 'X', message: 'Incorrect password.' } } } });
    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'nope' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlock' })); });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect password.');
    expect(screen.getByRole('dialog', { name: /screen locked/i })).toBeInTheDocument();
  });

  it('lets a cashier with a PIN unlock with the PIN keypad, and switch to the password', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: cashier, session: session({ idleSeconds: 999 }) } });
    await mount();
    const pin = screen.getByLabelText(/your pin/i);
    fireEvent.change(pin, { target: { value: '48a26' } });
    expect(pin.value).toBe('4826');                                   // digits only
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlock' })); });
    expect(authApi.unlock).toHaveBeenCalledWith({ pin: '4826' });
  });

  it('lets a cashier switch from the PIN to the password', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: cashier, session: session({ idleSeconds: 999 }) } });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /use my password instead/i }));
    expect(screen.getByLabelText(/your password/i)).toBeInTheDocument();
  });

  it('does not offer a PIN to managers', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: { ...manager, has_pin: true }, session: session({ idleSeconds: 999 }) } });
    await mount();
    expect(screen.queryByText(/use my pin instead/i)).toBeNull();
    expect(screen.getByLabelText(/your password/i)).toBeInTheDocument();
  });

  it('signs out when the idle limit passes (a device that was not remembered), with a notice for the sign-in page', async () => {
    refreshFails();
    await mount();
    await signIn();
    await advance(1801);
    expect(authApi.logout).toHaveBeenCalled();
    expect(screen.getByTestId('state')).toHaveTextContent('out');
    expect(sessionStorage.getItem('ut_flash')).toMatch(/idle/i);
  });

  it('a remembered device only locks when idle; it is never signed out for being idle', async () => {
    refreshFails();
    await mount();
    await signIn(manager, session({ remember: true, signOutAfterSeconds: null }));
    await advance(4 * 3600);
    expect(authApi.logout).not.toHaveBeenCalled();
    expect(screen.getByTestId('state')).toHaveTextContent('in:Mary Manager:locked');
  });

  it('the Lock screen button locks straight away', async () => {
    refreshFails();
    await mount();
    await signIn();
    await act(async () => { auth.lock(); });
    expect(screen.getByRole('dialog', { name: /screen locked/i })).toBeInTheDocument();
  });

  it('signing out from the lock screen ends the session', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: manager, session: session({ idleSeconds: 999 }) } });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
    expect(authApi.logout).toHaveBeenCalled();
    expect(screen.getByTestId('state')).toHaveTextContent('out');
  });

  it('signs out cleanly when the server ended the session while the screen was locked', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token: 't', user: manager, session: session({ idleSeconds: 999 }) } });
    await mount();
    authApi.unlock.mockRejectedValue({ response: { status: 401, data: { error: { code: 'SESSION_EXPIRED', message: 'Your session has ended.' } } } });
    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlock' })); });
    expect(screen.getByTestId('state')).toHaveTextContent('out');
    expect(sessionStorage.getItem('ut_flash')).toMatch(/session ended/i);
  });
});

// A stand-in server for the shared API client, so the real interceptors run.
function serverReplying(...steps) {
  const calls = [];
  client.defaults.adapter = async (config) => {
    calls.push({ url: config.url, auth: config.headers.Authorization });
    const step = steps.shift();
    const response = { data: step.data ?? {}, status: step.status, statusText: '', headers: {}, config };
    if (step.status >= 400) {
      const err = new axios.AxiosError('failed', 'ERR_BAD_REQUEST', config, null, response);
      throw err;
    }
    return response;
  };
  return calls;
}
const reject = (status, code) => ({ status, data: { error: { code, message: code } } });

describe('the API client with the lock and the confirm-it-is-you steps', () => {
  it('asks for the password, then repeats a risky request by itself', async () => {
    refreshFails();
    await mount();
    await signIn();
    const calls = serverReplying(reject(403, 'REAUTH_REQUIRED'), { status: 201, data: { ok: 'created' } });

    let result;
    await act(async () => { result = client.post('/staff', { name: 'x' }); await Promise.resolve(); });
    await flush();
    expect(screen.getByText(/confirm it's you/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'my-password' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
    const res = await result;
    expect(authApi.unlock).toHaveBeenCalledWith({ password: 'my-password' });
    expect(res.data.ok).toBe('created');
    expect(calls).toHaveLength(2);
    expect(screen.queryByText(/confirm it's you/i)).toBeNull();
  });

  it('fails the request if the person cancels the confirmation', async () => {
    refreshFails();
    await mount();
    await signIn();
    serverReplying(reject(403, 'REAUTH_REQUIRED'));
    let outcome;
    await act(async () => { outcome = client.post('/staff', {}).then(() => 'ok', (e) => e.response.data.error.code); await Promise.resolve(); });
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(await outcome).toBe('REAUTH_REQUIRED');
  });

  it('holds a request while the screen is locked and repeats it after unlocking', async () => {
    refreshFails();
    await mount();
    await signIn();
    const calls = serverReplying(reject(403, 'SESSION_LOCKED'), { status: 200, data: { rows: [1, 2] } });

    let result;
    await act(async () => { result = client.get('/products'); await Promise.resolve(); });
    await flush();
    expect(screen.getByRole('dialog', { name: /screen locked/i })).toBeInTheDocument();
    expect(calls).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlock' })); });
    expect((await result).data.rows).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it('refreshes an expired access token and repeats the request', async () => {
    refreshFails();
    await mount();
    await signIn();
    const calls = serverReplying(reject(401, 'TOKEN_EXPIRED'), { status: 200, data: { ok: true } });
    axios.post.mockResolvedValue({ data: { token: 'tok-2', user: manager, session: session() } });
    const res = await act(async () => client.get('/sales'));
    expect(res.data.ok).toBe(true);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('does not treat a wrong password on the unlock or change-password screens as a lost session', async () => {
    refreshFails();
    await mount();
    await signIn();
    serverReplying(reject(401, 'WRONG'));
    await expect(client.post('/auth/change-password', {})).rejects.toBeTruthy();
    expect(screen.getByTestId('state')).toHaveTextContent('in:Mary Manager');
  });
});
