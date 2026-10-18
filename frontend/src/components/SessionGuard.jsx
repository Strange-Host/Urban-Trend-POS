import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { lastActive, markActive } from '../api/sessionActivity';
import Sheet from './Sheet';

// Everything that makes the POS stop being "signed in forever" on the screen side:
//   - watches for real use (touch, keys, scrolling) and tells the server now and then, so the idle clock is honest
//   - warns, then locks the screen after the idle time (the server enforces the same lock, so this is not just cosmetic)
//   - signs out when the server's idle limit passes (not for devices marked "remember")
//   - shows the lock screen (password, or a PIN for cashiers) and the "confirm it's you" box for risky actions

const PING_EVERY_MS = 30 * 1000;
const WARN_BEFORE_LOCK_S = 30;

export default function SessionGuard() {
  const { user, session, locked, reauthOpen, lock, logout } = useAuth();
  const [warnSeconds, setWarnSeconds] = useState(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // Real use of the app. (Reading a page is "use"; background refreshes are not, they never call this.)
  useEffect(() => {
    let lastMark = 0;
    let lastPing = Date.now();
    const onActivity = () => {
      if (lockedRef.current) return;
      const now = Date.now();
      if (now - lastMark < 1000) return;
      lastMark = now;
      markActive(now);
      if (now - lastPing >= PING_EVERY_MS && document.visibilityState === 'visible') {
        lastPing = now;
        authApi.activity().catch(() => {});
      }
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'];
    events.forEach((ev) => window.addEventListener(ev, onActivity, { capture: true, passive: true }));
    return () => events.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }));
  }, []);

  // The idle clock: warn, lock, sign out.
  useEffect(() => {
    if (!session) return undefined;
    // Lock a little before the server would, so the screen never looks usable after the server has already locked.
    const lockMs = Math.max(30, session.lockAfterSeconds - 15) * 1000;
    const warnMs = lockMs - WARN_BEFORE_LOCK_S * 1000;
    const signOutMs = session.signOutAfterSeconds ? session.signOutAfterSeconds * 1000 : null;
    const tick = () => {
      const idle = Date.now() - lastActive();
      if (signOutMs && idle >= signOutMs) { logout('You were signed out because the app was left idle.'); return; }
      if (lockedRef.current) { setWarnSeconds(null); return; }
      if (idle >= lockMs) { setWarnSeconds(null); lock(); return; }
      setWarnSeconds(warnMs > 0 && idle >= warnMs ? Math.ceil((lockMs - idle) / 1000) : null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [session, lock, logout]);

  // Coming back to the tab after a while: re-check straight away instead of waiting for the next tick.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setWarnSeconds(null); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!user) return null;
  return (
    <>
      {warnSeconds !== null && !locked && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[150] w-[calc(100%-2rem)] max-w-sm rounded-xl bg-ink text-white shadow-xl px-4 py-3 text-sm flex items-center justify-between gap-3"
          role="status" aria-live="polite"
        >
          <span>Screen locks in <b>{warnSeconds}s</b> because it is idle.</span>
          <button type="button" onClick={() => { markActive(); setWarnSeconds(null); authApi.activity().catch(() => {}); }} className="min-h-[40px] px-3 rounded-lg bg-accent text-accent-ink font-medium">Stay</button>
        </div>
      )}
      {locked && <LockScreen />}
      {reauthOpen && !locked && <ReauthSheet />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The password / PIN form, shared by the lock screen and the confirm box.
// ---------------------------------------------------------------------------------------------------------------------
function IdentityForm({ user, onSubmit, submitLabel, dark = false, secondary }) {
  // Only a cashier with a PIN (and no sign-in codes) may unlock with it; everyone else uses their password.
  const canPin = user.role === 'cashier' && user.has_pin && !user.two_factor_enabled;
  const [mode, setMode] = useState(canPin ? 'pin' : 'password');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    // Don't pop the keyboard open on a phone before they've asked for it.
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus();
  }, [mode]);

  async function submit(e) {
    e.preventDefault();
    if (!value) return;
    setBusy(true); setError('');
    try {
      await onSubmit(mode === 'pin' ? { pin: value } : { password: value });
      setValue('');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not check that. Try again.'));
      setValue('');
    } finally { setBusy(false); }
  }

  const input = dark
    ? 'bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-accent'
    : 'bg-surface border-line text-text focus:border-accent';
  return (
    <form onSubmit={submit}>
      <label htmlFor="identity-secret" className={`block text-xs font-medium mb-1 ${dark ? 'text-white/60' : 'text-text-muted'}`}>
        {mode === 'pin' ? 'Your PIN' : 'Your password'}
      </label>
      <input
        id="identity-secret" ref={inputRef} type="password" value={value} onChange={(e) => setValue(mode === 'pin' ? e.target.value.replace(/\D/g, '') : e.target.value)}
        inputMode={mode === 'pin' ? 'numeric' : 'text'} pattern={mode === 'pin' ? '[0-9]*' : undefined} maxLength={mode === 'pin' ? 8 : 200}
        autoComplete={mode === 'pin' ? 'off' : 'current-password'} enterKeyHint="go"
        className={`w-full px-3 py-3 rounded-lg border outline-none ${mode === 'pin' ? 'text-2xl tracking-[0.4em] text-center font-mono' : 'text-base'} ${input}`}
        placeholder={mode === 'pin' ? '••••' : 'Password'}
      />
      {error && <p role="alert" className={`mt-2 text-sm ${dark ? 'text-red-300' : 'text-danger'}`}>{error}</p>}
      <button type="submit" disabled={busy || !value} className="mt-3 w-full min-h-[48px] rounded-lg bg-accent text-accent-ink font-medium disabled:opacity-50">
        {busy ? 'Checking…' : submitLabel}
      </button>
      <div className="mt-3 flex items-center justify-between gap-3 text-sm">
        {canPin ? (
          <button type="button" onClick={() => { setMode(mode === 'pin' ? 'password' : 'pin'); setValue(''); setError(''); }} className={`min-h-[44px] underline ${dark ? 'text-white/70' : 'text-text-muted'}`}>
            {mode === 'pin' ? 'Use my password instead' : 'Use my PIN instead'}
          </button>
        ) : <span />}
        {secondary}
      </div>
    </form>
  );
}

function LockScreen() {
  const { user, session, confirmIdentity, logout } = useAuth();

  async function unlock(secret) {
    try {
      await confirmIdentity(secret);
    } catch (err) {
      // The server ended the session while the screen was locked (idle too long, or it was signed out elsewhere).
      if (err?.response?.data?.error?.code === 'SESSION_EXPIRED' || err?.response?.status === 401 && /session|token/i.test(err?.response?.data?.error?.message || '')) {
        logout('You were signed out because the session ended. Please sign in again.');
        return;
      }
      throw err;
    }
  }

  const signOutMinutes = session?.signOutAfterSeconds ? Math.round(session.signOutAfterSeconds / 60) : null;
  return createPortal(
    <div className="fixed inset-0 z-[200] bg-ink text-white flex items-center justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Screen locked">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="mx-auto mb-3 w-14 h-14 rounded-full bg-white/10 flex items-center justify-center text-2xl" aria-hidden="true">🔒</div>
          <h1 className="font-display font-700 text-2xl">Screen locked</h1>
          <p className="text-white/60 text-sm mt-1">Signed in as <b className="text-white">{user.name}</b>. It locks when nobody has used it for a few minutes.</p>
        </div>
        <IdentityForm
          user={user} dark submitLabel="Unlock" onSubmit={unlock}
          secondary={<button type="button" onClick={() => logout()} className="min-h-[44px] text-white/70 underline">Sign out</button>}
        />
        {signOutMinutes && <p className="mt-4 text-xs text-white/40 text-center">If it stays locked, you are signed out completely after about {signOutMinutes} minutes without use.</p>}
      </div>
    </div>,
    document.body
  );
}

function ReauthSheet() {
  const { user, confirmIdentity, cancelReauth } = useAuth();
  return (
    <Sheet onClose={cancelReauth} size="sm" zIndex={120} label="Confirm it's you">
      <h2 className="font-display font-700 text-lg mb-1">Confirm it's you</h2>
      <p className="text-sm text-text-muted mb-4">This is a sensitive change, so please enter your {user.role === 'cashier' && user.has_pin && !user.two_factor_enabled ? 'PIN or password' : 'password'} again.</p>
      <IdentityForm
        user={user} submitLabel="Confirm" onSubmit={confirmIdentity}
        secondary={<button type="button" onClick={cancelReauth} className="min-h-[44px] text-text-muted underline">Cancel</button>}
      />
      <div className="h-4" />
    </Sheet>
  );
}
