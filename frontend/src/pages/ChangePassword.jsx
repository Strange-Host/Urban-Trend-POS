import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { minLengthFor, passwordHint, passwordChecks } from '../utils/passwordRules';

export default function ChangePassword() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword.length < minLengthFor(user?.role)) {
      setError(`New password must be at least ${minLengthFor(user?.role)} characters.`);
      return;
    }

    setLoading(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      // The backend revokes the session that made this call (see
      // auth.controller.js#changePassword) — there's no session left to
      // "upgrade" client-side, so the honest next step is a real
      // re-login with the new password, not pretending to stay signed in.
      logout();
      navigate('/login', { replace: true, state: { message: 'Password changed. Please sign in again.' } });
    } catch (err) {
      setError(getErrorMessage(err, 'Could not change your password.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-paper">
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <h1 className="font-display font-700 text-2xl mb-1">Set a new password</h1>
        <p className="text-text-muted text-sm mb-8">
          {user?.must_change_password
            ? "You're using a temporary password — set a real one before continuing."
            : 'Change your account password.'}
        </p>

        {error && (
          <div className="mb-4 px-3 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">
            {error}
          </div>
        )}

        <label className="block text-sm font-medium mb-1.5">Current password</label>
        <input
          type="password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-4"
          placeholder="••••••••"
        />

        <label className="block text-sm font-medium mb-1.5">New password</label>
        <input
          type="password"
          required
          minLength={minLengthFor(user?.role)}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-2"
          placeholder={`At least ${minLengthFor(user?.role)} characters`}
        />
        <p className="text-xs text-text-muted mb-1">{passwordHint(user?.role)}</p>
        <ul className="text-xs mb-4 space-y-0.5" aria-live="polite">
          {passwordChecks(newPassword, user?.role).map((c) => (
            <li key={c.text} className={c.ok ? 'text-success' : 'text-text-muted'}>{c.ok ? '✓' : '○'} {c.text}</li>
          ))}
        </ul>

        <label className="block text-sm font-medium mb-1.5">Confirm new password</label>
        <input
          type="password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-6"
          placeholder="••••••••"
        />

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-ink text-white font-medium hover:bg-ink-soft transition-colors disabled:opacity-50"
        >
          {loading ? 'Changing…' : 'Change password'}
        </button>

        {!user?.must_change_password && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="w-full py-2.5 mt-2 text-text-muted text-sm hover:text-text"
          >
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
