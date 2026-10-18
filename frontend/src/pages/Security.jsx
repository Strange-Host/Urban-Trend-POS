import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, securityApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast, useDialog } from '../context/UIContext';

// Security: your own sign-in (devices, lock, password) for everyone; the sign-in rules and the security log for admins.

function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(String(iso).includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const minutesText = (sec) => (sec % 3600 === 0 ? `${sec / 3600} hour${sec / 3600 === 1 ? '' : 's'}` : `${Math.round(sec / 60)} minutes`);

export default function Security() {
  const { user, session, lock, logout } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'admin';

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => authApi.sessions().then((r) => r.data.sessions),
  });

  async function endDevice(d) {
    if (d.current) {
      if (await dialog.confirm('Sign out of this device?')) logout();
      return;
    }
    try {
      await authApi.endSession(d.id);
      queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success(`${d.device} was signed out.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not sign that device out.'));
    }
  }

  async function endOthers() {
    if (!(await dialog.confirm({ message: 'Sign out every other device? You stay signed in here.', danger: true }))) return;
    try {
      const { data } = await authApi.endOtherSessions();
      queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success(data.ended ? `Signed out ${data.ended} other device${data.ended === 1 ? '' : 's'}.` : 'There were no other devices.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not sign the others out.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <h1 className="font-display font-700 text-2xl mb-1">Security</h1>
      <p className="text-text-muted text-sm mb-6">Where you are signed in, and how the POS protects your account.</p>

      <section className="bg-surface border border-line rounded-xl p-4 md:p-5 mb-5">
        <h2 className="font-medium mb-1">This sign-in</h2>
        {session ? (
          <ul className="text-sm text-text-muted space-y-1 mt-2">
            <li>The screen locks after <b className="text-text">{minutesText(session.lockAfterSeconds)}</b> without use. Your {user?.role === 'cashier' && user?.has_pin ? 'PIN or password' : 'password'} unlocks it.</li>
            <li>{session.remember
              ? <>This device is <b className="text-text">remembered</b>, so it stays signed in until <b className="text-text">{new Date(session.expiresAt).toLocaleString()}</b> at the latest.</>
              : <>You are signed out completely after <b className="text-text">{minutesText(session.signOutAfterSeconds)}</b> without use, and at the latest at <b className="text-text">{new Date(session.expiresAt).toLocaleString()}</b>.</>}
            </li>
          </ul>
        ) : <p className="text-sm text-text-muted">Loading…</p>}
        <div className="flex flex-wrap gap-2 mt-4">
          <button type="button" onClick={lock} className="min-h-[44px] px-4 rounded-lg border border-line text-sm font-medium hover:border-text-muted">Lock the screen now</button>
          <Link to="/change-password" className="min-h-[44px] px-4 rounded-lg border border-line text-sm font-medium hover:border-text-muted inline-flex items-center">Change my password</Link>
        </div>
      </section>

      <section className="bg-surface border border-line rounded-xl p-4 md:p-5 mb-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="font-medium">Devices signed in as you</h2>
          {devices.length > 1 && (
            <button type="button" onClick={endOthers} className="min-h-[44px] px-3 rounded-lg border border-danger/40 text-danger text-sm font-medium hover:bg-danger-soft">Sign out all others</button>
          )}
        </div>
        {isLoading && <p className="text-sm text-text-muted">Loading…</p>}
        <ul className="divide-y divide-line">
          {devices.map((d) => (
            <li key={d.id} className="py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex flex-wrap items-center gap-2">
                  {d.device}
                  {d.current && <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-soft text-success font-medium">This device</span>}
                  {d.remember && <span className="text-[10px] px-1.5 py-0.5 rounded bg-line text-text-muted font-medium">Remembered</span>}
                  {d.state === 'locked' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-line text-text-muted font-medium">Locked</span>}
                </div>
                <div className="text-xs text-text-muted truncate">Active {timeAgo(d.lastActiveAt)} · signed in {timeAgo(d.signedInAt)}{d.ip ? ` · ${d.ip}` : ''}</div>
              </div>
              <button type="button" onClick={() => endDevice(d)} className="shrink-0 min-h-[44px] px-3 rounded-lg border border-line text-sm font-medium hover:border-text-muted">
                {d.current ? 'Sign out' : 'Sign out device'}
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-text-muted mt-3">Don't recognise a device? Sign it out, then change your password.</p>
      </section>

      {isAdmin && <PolicyEditor />}
      {isAdmin && <EventsList />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin: the sign-in rules
// ---------------------------------------------------------------------------------------------------------------------
const ROLE_LABEL = { cashier: 'Cashiers (shared tills)', manager: 'Managers', admin: 'Admins' };

function PolicyEditor() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['security-policy'], queryFn: () => securityApi.policy().then((r) => r.data.data) });
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (data) setForm(JSON.parse(JSON.stringify(data))); }, [data]);
  if (!form) return null;

  const num = (v) => (v === '' ? '' : Number(v));
  const setRole = (role, key, v) => setForm((f) => ({ ...f, roles: { ...f.roles, [role]: { ...f.roles[role], [key]: num(v) } } }));
  const setTop = (path, v) => setForm((f) => {
    const next = JSON.parse(JSON.stringify(f));
    const [a, b] = path;
    if (b) next[a][b] = num(v); else next[a] = num(v);
    return next;
  });

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const { data: saved } = await securityApi.updatePolicy(form);
      queryClient.setQueryData(['security-policy'], saved.data ?? saved);
      queryClient.invalidateQueries({ queryKey: ['security-policy'] });
      toast.success('Security settings saved. They apply to new sign-ins.');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save.'));
    } finally { setSaving(false); }
  }

  const field = (label, value, onChange, hint) => (
    <label className="block">
      <span className="block text-xs font-medium text-text-muted mb-1">{label}</span>
      <input type="text" inputMode="numeric" pattern="[0-9]*" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        className="w-full px-3 py-2.5 rounded-lg border border-line bg-surface outline-none focus:border-accent font-mono" />
      {hint && <span className="block text-[11px] text-text-muted mt-1">{hint}</span>}
    </label>
  );

  return (
    <form onSubmit={save} className="bg-surface border border-line rounded-xl p-4 md:p-5 mb-5">
      <h2 className="font-medium mb-1">Sign-in rules</h2>
      <p className="text-sm text-text-muted mb-4">Changes apply to people when they next sign in. Saving asks you to confirm your password.</p>
      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm" role="alert">{error}</div>}

      {['cashier', 'manager', 'admin'].map((role) => (
        <fieldset key={role} className="mb-5">
          <legend className="text-sm font-medium mb-2">{ROLE_LABEL[role]}</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {field('Lock screen after (minutes idle)', form.roles[role].lockMinutes, (v) => setRole(role, 'lockMinutes', v))}
            {field('Sign out after (minutes idle)', form.roles[role].idleSignOutMinutes, (v) => setRole(role, 'idleSignOutMinutes', v), 'Not applied to remembered devices')}
            {field('Longest sign-in (hours)', form.roles[role].maxHours, (v) => setRole(role, 'maxHours', v), 'However active they are')}
          </div>
        </fieldset>
      ))}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        {field('Without "keep me signed in": longest sign-in (hours)', form.unrememberedMaxHours, (v) => setTop(['unrememberedMaxHours'], v))}
        {field('Ask for the password again after (minutes)', form.reauthMinutes, (v) => setTop(['reauthMinutes'], v), 'Before refunds, voids, stock changes, staff and settings changes')}
        {field('Wrong passwords before an account locks', form.lockout.attempts, (v) => setTop(['lockout', 'attempts'], v))}
        {field('Locked for (minutes)', form.lockout.minutes, (v) => setTop(['lockout', 'minutes'], v))}
      </div>

      <h3 className="text-sm font-medium mb-2">Tell the admins when…</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        {field('A refund or void is at least (KES)', form.alerts.refundKes, (v) => setTop(['alerts', 'refundKes'], v))}
        {field('Stock is adjusted by at least (units)', form.alerts.stockUnits, (v) => setTop(['alerts', 'stockUnits'], v))}
        {field('A price changes by at least (%)', form.alerts.pricePercent, (v) => setTop(['alerts', 'pricePercent'], v))}
      </div>

      <button type="submit" disabled={saving} className="min-h-[48px] px-5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
        {saving ? 'Saving…' : 'Save security settings'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin: what happened lately
// ---------------------------------------------------------------------------------------------------------------------
const SEVERITY = { urgent: 'bg-danger-soft text-danger', warning: 'bg-accent/25 text-ink', info: 'bg-line text-text-muted' };

function EventsList() {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['security-events'],
    queryFn: () => securityApi.events({ limit: 40 }).then((r) => r.data.data),
    refetchInterval: 60_000,
  });
  return (
    <section className="bg-surface border border-line rounded-xl p-4 md:p-5">
      <h2 className="font-medium mb-3">Recent security events</h2>
      {isLoading && <p className="text-sm text-text-muted">Loading…</p>}
      {!isLoading && events.length === 0 && <p className="text-sm text-text-muted">Nothing yet. Lockouts, password resets, large refunds and similar things will be listed here.</p>}
      <ul className="divide-y divide-line">
        {events.map((e) => (
          <li key={e.id} className="py-3">
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium uppercase ${SEVERITY[e.severity] || SEVERITY.info}`}>{e.severity}</span>
              <div className="min-w-0">
                <div className="text-sm font-medium break-words">{e.title}</div>
                {e.detail && <div className="text-xs text-text-muted break-words">{e.detail}</div>}
                <div className="text-[11px] text-text-muted mt-0.5">{timeAgo(e.created_at)}{e.ip ? ` · ${e.ip}` : ''}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
