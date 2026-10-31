import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { payrollApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/UIContext';

// How each person's commission is worked out. Admin only (the server enforces it too).
//   Fixed        a set amount per unit sold; leave the amount empty to use the store's achievement tiers
//   Percentage   a share of each secured order's value
//   Combined     both, added together
// Changing someone's terms affects drafts calculated from now on. An approved run never changes.

const TYPES = [
  { value: 'fixed', label: 'Fixed per unit' },
  { value: 'percentage', label: 'Percentage of sales' },
  { value: 'combined', label: 'Combined' },
];
const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });

const toDraft = (t) => ({
  type: t.type,
  fixedKes: t.fixedCents == null ? '' : String(t.fixedCents / 100),
  percent: t.percentBp ? String(t.percentBp / 100) : '',
});
const summary = (t) => {
  const unit = t.fixedCents == null ? 'tier rate per unit' : `${money(t.fixedCents)} per unit`;
  if (t.type === 'percentage') return `${t.percentBp / 100}% of each sale`;
  if (t.type === 'combined') return `${unit} + ${t.percentBp / 100}% of each sale`;
  return unit;
};

function Row({ term, onSaved }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => toDraft(term));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const showFixed = draft.type !== 'percentage';
  const showPercent = draft.type !== 'fixed';

  async function save() {
    setBusy(true);
    setError('');
    try {
      await payrollApi.setPayTerms(term.staffId, {
        type: draft.type,
        fixed_cents: showFixed && draft.fixedKes !== '' ? Math.round(Number(draft.fixedKes) * 100) : null,
        percent_bp: showPercent ? Math.round(Number(draft.percent || 0) * 100) : 0,
      });
      toast.success(`Pay terms saved for ${term.name}.`);
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save those terms.'));
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 block w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-text outline-none focus:border-accent';
  return (
    <li className="px-4 py-3 border-b border-line last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium text-sm">{term.name}</div>
          <div className="text-xs text-text-muted">{TYPES.find((x) => x.value === term.type)?.label} · {summary(term)}</div>
        </div>
        {!editing && (
          <button onClick={() => { setDraft(toDraft(term)); setEditing(true); }} className="text-xs px-3 py-1.5 rounded-lg border border-line hover:border-text-muted">Edit</button>
        )}
      </div>
      {editing && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3 items-end">
          <label className="text-xs text-text-muted">Pay type
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} className={input}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          {showFixed && (
            <label className="text-xs text-text-muted">Amount per unit (KES)
              <input type="number" min="0" step="any" value={draft.fixedKes} placeholder="Use store tiers" onChange={(e) => setDraft({ ...draft, fixedKes: e.target.value })} className={input} />
            </label>
          )}
          {showPercent && (
            <label className="text-xs text-text-muted">Share of each sale (%)
              <input type="number" min="0" max="100" step="any" value={draft.percent} onChange={(e) => setDraft({ ...draft, percent: e.target.value })} className={input} />
            </label>
          )}
          <div className="sm:col-span-3 flex flex-wrap gap-2 items-center">
            <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Save</button>
            <button onClick={() => setEditing(false)} className="px-4 py-2 rounded-lg border border-line text-sm">Cancel</button>
            {error && <span className="text-sm text-danger" role="alert">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function PayTerms() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { data: terms, isLoading, error } = useQuery({
    queryKey: ['payroll', 'pay-terms'], queryFn: () => payrollApi.payTerms().then((r) => r.data.data), enabled: isAdmin,
  });

  if (!isAdmin) {
    return <div className="p-4 md:p-6 text-sm text-text-muted">Only an admin can see or change how people are paid.</div>;
  }
  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <h1 className="font-display font-700 text-2xl mb-1">Pay terms</h1>
      <p className="text-text-muted text-sm mb-5">
        How each person&apos;s commission is worked out. Changes apply to drafts calculated from now on; an approved run never changes.
      </p>
      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm" role="alert">{getErrorMessage(error, 'Could not load pay terms.')}</div>}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        {isLoading && <div className="p-4 text-sm text-text-muted">Loading…</div>}
        {terms && terms.length === 0 && <div className="p-4 text-sm text-text-muted">No active staff.</div>}
        <ul>
          {(terms || []).map((t) => <Row key={`${t.staffId}-${t.type}-${t.fixedCents}-${t.percentBp}`} term={t} onSaved={() => qc.invalidateQueries({ queryKey: ['payroll'] })} />)}
        </ul>
      </div>
    </div>
  );
}
