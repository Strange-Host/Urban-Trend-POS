import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { staffApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';
import Sheet from './Sheet';

// "Remove" for a staff account. Dozens of records point at a staff member (sales, cash sessions, stock changes...),
// so there are three honest options, each explained in plain words and each only offered when it is possible:
//   Deactivate · Delete permanently (only if the account never did anything) · Erase personal data (keep the records)
export default function RemoveAccountSheet({ staff, onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const { data: check, isLoading } = useQuery({
    queryKey: ['staff-removal-check', staff.id],
    queryFn: () => staffApi.removalCheck(staff.id).then((r) => r.data.data),
    staleTime: 0,
  });

  const done = (message) => {
    queryClient.invalidateQueries({ queryKey: ['staff'] });
    toast.success(message);
    onClose();
  };
  async function run(kind, fn, message) {
    setBusy(kind); setError('');
    try { await fn(); done(message); } catch (err) { setError(getErrorMessage(err, 'That did not work.')); } finally { setBusy(null); }
  }

  const nameOk = typed.trim() === staff.name;
  const history = check?.hasActivity
    ? Object.entries(check.activity).map(([k, v]) => `${v} ${k}`).join(', ')
    : null;

  return (
    <Sheet onClose={onClose} size="md" label={`Remove ${staff.name}`}>
      <h2 className="font-display font-700 text-lg mb-1">Remove {staff.name}</h2>
      <p className="text-sm text-text-muted mb-4">Choose what should happen to this account. Their sales and records are never lost unless the account never did anything.</p>
      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm" role="alert">{error}</div>}
      {isLoading && <p className="text-sm text-text-muted">Checking…</p>}

      {check && (
        <div className="space-y-3">
          {/* 1. Deactivate */}
          <div className="rounded-xl border border-line p-4">
            <h3 className="font-medium text-sm">1. Deactivate</h3>
            <p className="text-sm text-text-muted mt-1">They can no longer sign in. Everything they did stays exactly as it is, and you can switch them back on later.</p>
            {check.active ? (
              <button type="button" disabled={!!busy || check.reasons.some((r) => /only active admin|own account/i.test(r))}
                onClick={() => run('deactivate', () => staffApi.remove(staff.id), `${staff.name} was deactivated.`)}
                className="mt-3 min-h-[44px] px-4 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50">
                {busy === 'deactivate' ? 'Working…' : 'Deactivate'}
              </button>
            ) : <p className="mt-2 text-xs text-text-muted">Already deactivated.</p>}
          </div>

          {/* 2. Delete permanently */}
          <div className="rounded-xl border border-line p-4">
            <h3 className="font-medium text-sm">2. Delete permanently</h3>
            <p className="text-sm text-text-muted mt-1">For accounts that never did anything, like a test account or one made by mistake. It is removed completely.</p>
            {check.canDeletePermanently ? (
              <ConfirmBlock name={staff.name} typed={typed} setTyped={setTyped}>
                <button type="button" disabled={!nameOk || !!busy}
                  onClick={() => run('delete', () => staffApi.permanentDelete(staff.id, typed.trim()), `${staff.name} was deleted.`)}
                  className="min-h-[44px] px-4 rounded-lg bg-danger text-white text-sm font-medium disabled:opacity-40">
                  {busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
                </button>
              </ConfirmBlock>
            ) : (
              <p className="mt-2 text-xs text-text-muted">
                Not available{history ? <>: this account has history ({history}) that must be kept. Use option 3 for a former employee.</> : <>: {check.reasons.join(' ')}</>}
              </p>
            )}
          </div>

          {/* 3. Erase personal data */}
          <div className="rounded-xl border border-line p-4">
            <h3 className="font-medium text-sm">3. Erase personal data, keep the records</h3>
            <p className="text-sm text-text-muted mt-1">
              For a former employee who has history. Their name, email, phone, password, PIN and HR documents are wiped. The account stays as
              <b> “Former staff #{staff.id}”</b>, so receipts, sales and reports still add up. This cannot be undone.
            </p>
            {check.erased ? (
              <p className="mt-2 text-xs text-text-muted">Already erased.</p>
            ) : check.eraseNeedsDeactivation ? (
              <p className="mt-2 text-xs text-text-muted">Deactivate the account first (option 1), then come back here.</p>
            ) : check.canErase ? (
              <ConfirmBlock name={staff.name} typed={typed} setTyped={setTyped}>
                <button type="button" disabled={!nameOk || !!busy}
                  onClick={() => run('erase', () => staffApi.erasePersonalData(staff.id, typed.trim()), `Personal data for ${staff.name} was erased.`)}
                  className="min-h-[44px] px-4 rounded-lg bg-danger text-white text-sm font-medium disabled:opacity-40">
                  {busy === 'erase' ? 'Erasing…' : 'Erase personal data'}
                </button>
              </ConfirmBlock>
            ) : <p className="mt-2 text-xs text-text-muted">Not available: {check.reasons.join(' ')}</p>}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 min-h-[44px] rounded-lg border border-line text-sm font-medium">Close</button>
      </div>
    </Sheet>
  );
}

function ConfirmBlock({ name, typed, setTyped, children }) {
  return (
    <div className="mt-3">
      <label className="block text-xs text-text-muted mb-1">Type <b className="text-text">{name}</b> to confirm</label>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false"
        className="w-full px-3 py-2.5 rounded-lg border border-line bg-surface outline-none focus:border-accent mb-3" />
      {children}
    </div>
  );
}
