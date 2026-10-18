import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getErrorMessage, takeFlash } from '../api/client';
import { authApi } from '../api/endpoints';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, verifyOtp } = useAuth();
  const navigate = useNavigate();

  // Step 2 of sign-in, only for accounts with SMS sign-in codes switched on.
  const [challenge, setChallenge] = useState(null); // { challengeToken, phoneHint }
  const [code, setCode] = useState('');
  const [resendNote, setResendNote] = useState('');
  // "Keep me signed in on this device": only for your own phone or computer. Unticked, the sign-in ends when the
  // browser is closed (and sooner if it is left idle). Never tick it on a shared till.
  const [remember, setRemember] = useState(false);
  // Why we landed here (e.g. "signed out because the session ended"), left by the page that signed you out.
  const [notice] = useState(() => takeFlash());

  function describe(err, fallback) {
    if (!err.response) {
      // No response at all — DNS/connection failure, CORS block, wrong VITE_API_URL,
      // backend not running, etc. This is NOT a credentials problem, and showing the
      // same "check your details" message for it is actively misleading.
      return "Could not reach the server. Check that the backend is running (cd backend && npm run dev) and that this device is on the same network.";
    }
    return getErrorMessage(err, fallback);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email.trim().toLowerCase(), password, remember);
      if (result.twoFactorRequired) {
        setChallenge(result);
        setPassword('');
        return;
      }
      navigate('/');
    } catch (err) {
      setError(describe(err, 'Could not sign in. Check your details and try again.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyOtp(challenge.challengeToken, code.trim(), remember);
      navigate('/');
    } catch (err) {
      setError(describe(err, 'That code did not work.'));
      setCode('');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setError('');
    setResendNote('');
    try {
      await authApi.resendOtp(challenge.challengeToken);
      setResendNote('A new code is on its way.');
    } catch (err) {
      setError(describe(err, 'Could not send a new code.'));
    }
  }

  function startOver() {
    setChallenge(null);
    setCode('');
    setError('');
    setResendNote('');
  }

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-1/2 bg-ink text-white flex-col justify-between p-12">
        <div className="font-display font-700 text-2xl tracking-tight">Urban Trends</div>
        <div>
          <div className="font-display font-600 text-4xl leading-tight max-w-md">
            Ring up sales. Track stock. Run the floor.
          </div>
          <p className="text-white/50 mt-4 max-w-sm">
            One terminal for checkout, inventory, and reporting — built for a team, not just a till.
          </p>
        </div>
        <div className="text-white/30 text-sm font-mono">v1.0 · point of sale</div>
      </div>

      <div className="flex-1 flex items-center justify-center p-8 bg-paper">
        {challenge ? (
          <form onSubmit={handleVerify} className="w-full max-w-sm">
            <h1 className="font-display font-700 text-2xl mb-1">Enter your code</h1>
            <p className="text-text-muted text-sm mb-8">
              We sent a 6-digit code to <span className="font-mono text-text">{challenge.phoneHint}</span>. It expires in a few minutes.
            </p>

            {error && <div className="mb-4 px-3 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
            {resendNote && !error && <div className="mb-4 px-3 py-2.5 rounded-lg bg-success-soft text-success text-sm">{resendNote}</div>}

            <label className="block text-sm font-medium mb-1.5" htmlFor="otp-code">Sign-in code</label>
            <input
              id="otp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-6 font-mono tracking-[0.4em] text-lg text-center"
              placeholder="······"
            />

            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full py-2.5 rounded-lg bg-ink text-white font-medium hover:bg-ink-soft transition-colors disabled:opacity-50"
            >
              {loading ? 'Checking…' : 'Verify and sign in'}
            </button>

            <div className="flex justify-between mt-4 text-sm">
              <button type="button" onClick={handleResend} className="text-text-muted hover:text-text">Send a new code</button>
              <button type="button" onClick={startOver} className="text-text-muted hover:text-text">Use a different account</button>
            </div>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <h1 className="font-display font-700 text-2xl mb-1">Sign in</h1>
          <p className="text-text-muted text-sm mb-8">Use your Urban Trends staff account.</p>

          {notice && !error && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-paper border border-line text-sm" role="status">{notice}</div>
          )}
          {error && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-danger-soft text-danger text-sm" role="alert">
              {error}
            </div>
          )}

          <label className="block text-sm font-medium mb-1.5">Email</label>
          <input
            type="email"
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-4"
            placeholder="you@urbantrends.com"
          />

          <label className="block text-sm font-medium mb-1.5">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-4"
            placeholder="••••••••"
            autoComplete="current-password"
          />

          <label className="flex items-start gap-3 mb-6 min-h-[44px] cursor-pointer">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 w-5 h-5 shrink-0 accent-[var(--color-ink)]" />
            <span className="text-sm">
              <span className="font-medium">Keep me signed in on this device</span>
              <span className="block text-xs text-text-muted">Only on your own phone or computer. On a shared till, leave this off.</span>
            </span>
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-ink text-white font-medium hover:bg-ink-soft transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          {import.meta.env.DEV && (
            <p className="text-xs text-text-muted mt-6 font-mono">
              demo/dev: check the backend's console output from when it seeded the database —
              a one-time admin password is printed there once (never the same value twice).
            </p>
          )}
        </form>
        )}
      </div>
    </div>
  );
}
