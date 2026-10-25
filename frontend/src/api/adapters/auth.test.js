import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import client, { getErrorMessage, performRefresh, clearAccessToken } from '../client';
import { adaptUser, adaptSessionPayload, newAuthApi } from './auth';
import login from './__fixtures__/auth-login.json';
import refresh from './__fixtures__/auth-refresh.json';
import me from './__fixtures__/auth-me.json';
import sessions from './__fixtures__/auth-sessions.json';
import wrong from './__fixtures__/auth-error.json';

// These fixtures are recorded answers of the real new server (server/tests/contractFixtures.test.ts keeps them honest).
afterEach(() => { vi.restoreAllMocks(); clearAccessToken(); });

describe('the person', () => {
  it('becomes the legacy user the screens read: name, 0/1 flags and the permission keys as a list', () => {
    const u = adaptUser(login.user, login.uiPermissions);
    expect(u).toMatchObject({ id: login.user.id, name: 'Fixture Manager', email: 'fixture@shop.test', role: 'manager', is_active: 1, must_change_password: 0, two_factor_enabled: 0, has_pin: false });
    expect(u.permissions).toContain('reports.view');
    expect(u.permissions).not.toContain('payroll.approve'); // not a delegable key
    expect(u).not.toHaveProperty('displayName');
    expect(JSON.stringify(u)).not.toMatch(/password_hash|pin_hash|scrypt/i);
  });
  it('carries the flags the lock screen decides on', () => {
    const base = { ...login.user, role: 'cashier', hasPin: true, twoFactorEnabled: false, mustChangePassword: true };
    expect(adaptUser(base, [])).toMatchObject({ has_pin: true, two_factor_enabled: 0, must_change_password: 1 });
    expect(adaptUser({ ...base, twoFactorEnabled: true }, []).two_factor_enabled).toBe(1);
  });
});

describe('the sign-in payload', () => {
  it('becomes { token, user, session } and keeps the session policy exactly as the lock screen needs it', () => {
    const d = adaptSessionPayload(login);
    expect(d.token).toBe('ACCESS_TOKEN');
    expect(d.user.name).toBe('Fixture Manager');
    for (const k of ['id', 'remember', 'lockAfterSeconds', 'signOutAfterSeconds', 'expiresAt', 'reauthMinutes', 'lastActivityAt', 'idleSeconds']) expect(d.session, k).toHaveProperty(k);
    expect(typeof d.session.lockAfterSeconds).toBe('number');
  });
  it('is safe to run twice, and leaves a legacy answer and a person-less answer alone', () => {
    const once = adaptSessionPayload(login);
    expect(adaptSessionPayload(once)).toBe(once);
    const legacy = { token: 't', user: { id: 1, name: 'Old', role: 'admin', permissions: [] }, session: {} };
    expect(adaptSessionPayload(legacy)).toBe(legacy);
    expect(adaptSessionPayload({ ok: true })).toEqual({ ok: true });
    expect(adaptSessionPayload(undefined)).toBeUndefined();
  });
  it('has no refresh token anywhere in the body: it only ever travels as a cookie', () => {
    expect(JSON.stringify([login, refresh, me])).not.toMatch(/refresh_?token/i);
  });
});

describe('the auth calls', () => {
  it('login sends the email, password and remember flag and hands back the adapted payload inside an axios-style response', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ status: 200, data: login });
    const res = await newAuthApi.login('fixture@shop.test', 'pw', true);
    expect(post).toHaveBeenCalledWith('/auth/login', { email: 'fixture@shop.test', password: 'pw', remember: true });
    expect(res.status).toBe(200);
    expect(res.data.user.name).toBe('Fixture Manager');
    expect(res.data.token).toBe('ACCESS_TOKEN');
  });
  it('me and refresh are adapted the same way', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ data: me });
    vi.spyOn(client, 'post').mockResolvedValue({ data: refresh });
    expect((await newAuthApi.me()).data.user.role).toBe('manager');
    expect((await newAuthApi.refresh()).data.token).toBe('ACCESS_TOKEN');
  });
  it('unlock, activity and devices pass through unchanged: same routes, same shapes', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ data: { ok: true } });
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: sessions });
    const del = vi.spyOn(client, 'delete').mockResolvedValue({ data: { ok: true } });
    await newAuthApi.unlock({ pin: '4829' });
    await newAuthApi.activity();
    await newAuthApi.endOtherSessions();
    await newAuthApi.endSession(9);
    expect((await newAuthApi.sessions()).data.sessions[0]).toMatchObject({ current: true, device: expect.any(String), state: 'active' });
    expect(post.mock.calls.map((c) => c[0])).toEqual(['/auth/unlock', '/auth/activity', '/auth/sessions/revoke-others']);
    expect(get).toHaveBeenCalledWith('/auth/sessions');
    expect(del).toHaveBeenCalledWith('/auth/sessions/9');
  });
  it('shows the server\'s own message for a wrong password, because the error contract is the same', () => {
    expect(getErrorMessage({ response: { data: wrong } })).toBe('Wrong username or password.');
    expect(wrong.error.code).toBe('BAD_CREDENTIALS');
  });
  it('says plainly that sign-in codes are not on the new server yet', async () => {
    const err = await newAuthApi.verifyOtp().catch((e) => e);
    expect(getErrorMessage(err)).toMatch(/not available on the new server/);
  });
});

describe('restoring a session on a page reload (the legacy performRefresh)', () => {
  it('adapts the new server\'s refresh answer, so AuthContext gets a user with a name and sets the access token', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: refresh });
    const data = await performRefresh();
    expect(data.user.name).toBe('Fixture Manager');
    expect(data.token).toBe('ACCESS_TOKEN');
  });
});
