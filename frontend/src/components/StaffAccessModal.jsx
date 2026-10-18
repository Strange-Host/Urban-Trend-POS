import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';

import Sheet from './Sheet';
// One person's access: which individual permissions differ from their role's
// defaults, and whether sign-in needs an SMS code. Admins cannot be restricted
// (the server enforces it) — that is what guarantees nobody can lock themselves out.
const CHOICES = [
  { value: 'default', label: 'Role default' },
  { value: 'allow', label: 'Always allow' },
  { value: 'block', label: 'Always block' },
];

const toChoice = (override) => (override === true ? 'allow' : override === false ? 'block' : 'default');
const toOverride = (choice) => (choice === 'allow' ? true : choice === 'block' ? false : null);

export default function StaffAccessModal({ staff, isSelf, onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState(null);
  const [saving, setSaving] = useState(false);
  const [twoFactor, setTwoFactor] = useState(staff.two_factor_enabled === 1);
  const [tfBusy, setTfBusy] = useState(false);
  const [tfError, setTfError] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['staff-permissions', staff.id],
    queryFn: () => accessApi.getPermissions(staff.id).then((r) => r.data.data),
  });

  useEffect(() => {
    if (data) setChoices(Object.fromEntries(data.permissions.map((p) => [p.key, toChoice(p.override)])));
  }, [data]);

  const locked = data?.locked;

  const changed = data && choices
    ? data.permissions.filter((p) => choices[p.key] !== toChoice(p.override))
    : [];

  async function save() {
    setSaving(true);
    try {
      const overrides = Object.fromEntries(changed.map((p) => [p.key, toOverride(choices[p.key])]));
      await accessApi.setPermissions(staff.id, overrides);
      queryClient.invalidateQueries({ queryKey: ['staff-permissions', staff.id] });
      toast.success('Permissions saved. They apply from the next thing this person does.');
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not save permissions.'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleTwoFactor() {
    setTfBusy(true);
    setTfError('');
    try {
      await accessApi.setTwoFactor(staff.id, !twoFactor);
      setTwoFactor(!twoFactor);
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      toast.success(!twoFactor ? 'Sign-in codes turned on.' : 'Sign-in codes turned off.');
    } catch (err) {
      setTfError(getErrorMessage(err, 'Could not change sign-in codes.'));
    } finally {
      setTfBusy(false);
    }
  }

  const groups = data ? [...new Set(data.permissions.map((p) => p.group))] : [];

  return (
    <Sheet onClose={onClose} size="lg" bare className="flex flex-col" label={`Access for ${staff.name}`}>
        <div className="px-6 pt-6 pb-3">
          <h2 className="font-display font-700 text-lg">Access for {staff.name}</h2>
          <p className="text-xs text-text-muted capitalize mt-0.5">{staff.role}</p>
        </div>

        <div className="px-6 overflow-y-auto flex-1">
          <div className="border border-line rounded-lg p-4 mb-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Sign-in code by SMS</div>
                <p className="text-xs text-text-muted mt-1">
                  After the password, a 6-digit code is texted to {staff.phone || 'their phone'}. Turns off the PIN shortcut for this account.
                  If the SMS provider is ever down, run <span className="font-mono">npm run disable-2fa -- {staff.email}</span> on the server.
                </p>
              </div>
              <button type="button" onClick={toggleTwoFactor} disabled={tfBusy} role="switch" aria-checked={twoFactor}
                className={`shrink-0 w-11 h-6 rounded-full relative transition-colors disabled:opacity-50 ${twoFactor ? 'bg-success' : 'bg-line'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${twoFactor ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
            {tfError && <div className="mt-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-xs">{tfError}</div>}
          </div>

          <div className="text-sm font-medium mb-1">Permissions</div>
          {isLoading && <div className="text-sm text-text-muted py-4">Loading…</div>}
          {error && <div className="px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, 'Could not load permissions.')}</div>}
          {locked && <p className="text-xs text-text-muted mb-4">Admins always have every permission and can't be restricted.</p>}
          {isSelf && !locked && <p className="text-xs text-text-muted mb-4">You can't change your own permissions.</p>}

          {data && choices && groups.map((group) => (
            <div key={group} className="mb-4">
              <div className="text-[11px] uppercase tracking-wide text-text-muted mb-1.5">{group}</div>
              {data.permissions.filter((p) => p.group === group).map((p) => (
                <div key={p.key} className="flex items-center justify-between gap-3 py-1.5 border-b border-line last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm">{p.label}</div>
                    <div className="text-[11px] text-text-muted">Role default: {p.role_default ? 'allowed' : 'not allowed'}</div>
                  </div>
                  <select
                    value={choices[p.key]} disabled={locked || isSelf}
                    onChange={(e) => setChoices({ ...choices, [p.key]: e.target.value })}
                    aria-label={p.label}
                    className={`shrink-0 px-2 py-1.5 rounded-lg border text-xs outline-none focus:border-accent disabled:opacity-50 ${
                      choices[p.key] === 'allow' ? 'border-success text-success' : choices[p.key] === 'block' ? 'border-danger text-danger' : 'border-line'
                    }`}
                  >
                    {CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-line flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>
          <button type="button" onClick={save} disabled={saving || locked || isSelf || changed.length === 0}
            className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
            {saving ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'No changes'}
          </button>
        </div>
    </Sheet>
  );
}
