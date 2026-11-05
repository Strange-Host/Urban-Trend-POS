import { useState } from 'react';
import PageHeader from '../components/shell/PageHeader';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { custodyApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';
import { StatusPill } from '../components/DataUI';
import StatCard from '../components/StatCard';
import Sheet from '../components/Sheet';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyRow } from '../components/EmptyState';

const money = (c) => `KES ${((c || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// opened_at is SQLite's datetime('now'): UTC, "YYYY-MM-DD HH:MM:SS".
export function ageInDays(openedAt, now = Date.now()) {
  const t = Date.parse(`${String(openedAt).replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 86400000));
}
// Same thresholds as the Money at risk page: a week old is where someone should be chased today.
const ageTone = (days) => (days >= 7 ? 'danger' : days >= 3 ? 'accent' : 'neutral');
const ageLabel = (days) => (days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`);

// Shop cash taken against an order is held by whoever took it until it is deposited. A deposit closes the whole
// record for good: there is no partial amount, and the record never changes afterwards.
export default function Custody() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState(null);
  const [error, setError] = useState('');

  const { data: records = [], isLoading, error: loadError } = useQuery({
    queryKey: ['custody'],
    queryFn: () => custodyApi.list().then((r) => r.data.data),
  });

  const deposit = useMutation({
    mutationFn: (id) => custodyApi.deposit(id),
    onSuccess: () => {
      toast.success('Deposit recorded. The record is closed.');
      setTarget(null);
      queryClient.invalidateQueries({ queryKey: ['custody'] });
      queryClient.invalidateQueries({ queryKey: ['money-at-risk'] });
    },
    onError: (err) => {
      setError(getErrorMessage(err, 'Could not record the deposit.'));
      // Someone else may have just closed it: reload so the list tells the truth.
      if (err?.response?.status === 409) queryClient.invalidateQueries({ queryKey: ['custody'] });
    },
  });

  const total = records.reduce((n, r) => n + r.amount, 0);
  const oldest = records.length ? Math.max(...records.map((r) => ageInDays(r.opened_at))) : 0;
  const holders = new Set(records.map((r) => r.holder_staff_id)).size;

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <PageHeader
        title="Custody"
        description="Shop cash still in someone's hands, oldest first. Record the deposit once it has reached the till or bank."
      />

      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard label="Held, not deposited" value={money(total)} sub={`${records.length} record${records.length === 1 ? '' : 's'}`} />
        <StatCard label="Holders" value={holders} />
        <StatCard label="Oldest" value={records.length ? ageLabel(oldest) : '—'} />
      </div>

      {loadError && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(loadError, 'Could not load custody records.')}</div>}

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Holder</th>
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Age</th>
              <th className="px-4 py-3 font-medium text-right">Amount</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows cols={5} />}
            {!isLoading && !loadError && records.length === 0 && <EmptyRow colSpan={5}>No shop cash is being held. Everything taken at the shop has been deposited.</EmptyRow>}
            {records.map((r) => {
              const days = ageInDays(r.opened_at);
              return (
                <tr key={r.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3 font-medium">{r.holder}<div className="text-xs text-text-muted font-normal">{r.reason}</div></td>
                  <td className="px-4 py-3">{r.order_ref || `#${r.order_id}`}</td>
                  <td className="px-4 py-3"><StatusPill tone={ageTone(days)}>{ageLabel(days)}</StatusPill></td>
                  <td className="px-4 py-3 text-right font-mono">{money(r.amount)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => { setError(''); setTarget(r); }} className="text-xs font-medium text-text hover:opacity-70">Record deposit</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {target && (
        <Sheet onClose={() => setTarget(null)} size="sm" label="Record deposit">
          <h2 className="font-display font-700 text-lg mb-1">Record deposit</h2>
          <p className="text-sm text-text-muted mb-4">Confirm the cash has been handed in. This closes the record and cannot be undone.</p>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <dl className="text-sm border border-line rounded-lg divide-y divide-line mb-5">
            <div className="px-3 py-2 flex justify-between gap-3"><dt className="text-text-muted">Held by</dt><dd>{target.holder}</dd></div>
            <div className="px-3 py-2 flex justify-between gap-3"><dt className="text-text-muted">Order</dt><dd>{target.order_ref || `#${target.order_id}`}</dd></div>
            <div className="px-3 py-2 flex justify-between gap-3"><dt className="text-text-muted">Reason</dt><dd className="text-right">{target.reason}</dd></div>
            <div className="px-3 py-2 flex justify-between gap-3 font-medium"><dt>Amount deposited</dt><dd className="font-mono">{money(target.amount)}</dd></div>
          </dl>
          <div className="flex gap-2">
            <button type="button" onClick={() => setTarget(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="button" disabled={deposit.isPending} onClick={() => { setError(''); deposit.mutate(target.id); }}
              className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{deposit.isPending ? 'Recording…' : `Confirm ${money(target.amount)} deposited`}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
