import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ordersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { PageHeader, KpiTile, StatusPill } from '../components/DataUI';

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
}

// One entry per kind the server can raise. A kind the server sends that is not listed here still
// shows (under its raw name), so adding a kind on the backend never blanks this page.
const KINDS = {
  dispatched_no_outcome: { label: 'No outcome', hint: 'Dispatched, nothing paid, no return' },
  delivered_unpaid: { label: 'Balance owed', hint: 'Part paid, balance still owed' },
  unmatched_payment: { label: 'Unmatched payment', hint: 'Money received that matches no order' },
  returning: { label: 'Parcel returning', hint: 'On its way back from a failed delivery' },
  till_session_left_open: { label: 'Till left open', hint: 'A till session nobody closed out' },
};
const kindLabel = (k) => KINDS[k]?.label || k;

// A week old is where "late" turns into "someone should be chased today".
const ageTone = (days) => (days >= 7 ? 'danger' : days >= 3 ? 'accent' : 'neutral');

export default function MoneyAtRisk() {
  const [kind, setKind] = useState('all');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['money-at-risk'],
    queryFn: () => ordersApi.atRisk().then((r) => r.data),
  });

  const all = data?.data || [];
  const summary = data?.summary;
  const rows = kind === 'all' ? all : all.filter((i) => i.kind === kind);
  const kindsPresent = Object.keys(KINDS).filter((k) => summary?.by_kind?.[k]?.count > 0);

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <PageHeader
        eyebrow={summary ? (summary.count > 0 ? `${summary.count} to look at` : 'All clear') : 'Money at risk'}
        title="Money at risk"
        description="Where money or goods may be going missing, oldest first. Each line says how long it has been waiting and whose it is. Nothing here is a decision made for you; it is the list to work through each morning."
        meta={summary?.amount > 0 ? `${money(summary.amount)}\nacross ${summary.count} item${summary.count === 1 ? '' : 's'}` : null}
        actions={(
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="px-3 py-1.5 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      />

      {isError && (
        <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">
          {getErrorMessage(error, 'Could not load the money-at-risk list.')}
        </div>
      )}
      {isLoading && <div className="text-text-muted text-sm">Loading…</div>}

      {summary && summary.count > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            {Object.keys(KINDS).map((k) => {
              const s = summary.by_kind[k] || { count: 0, amount: 0 };
              return (
                <button
                  key={k}
                  onClick={() => setKind(kind === k ? 'all' : k)}
                  disabled={s.count === 0}
                  aria-pressed={kind === k}
                  title={KINDS[k].hint}
                  className={`text-left rounded-xl disabled:opacity-40 ${kind === k ? 'ring-2 ring-accent' : ''}`}
                >
                  <KpiTile
                    label={KINDS[k].label}
                    value={s.count}
                    delta={s.amount > 0 ? money(s.amount) : null}
                    deltaTone={s.count > 0 ? 'danger' : 'neutral'}
                  />
                </button>
              );
            })}
          </div>
          {kindsPresent.length > 1 && kind !== 'all' && (
            <button onClick={() => setKind('all')} className="mb-3 text-xs text-text-muted underline">
              Show everything
            </button>
          )}
        </>
      )}

      {!isLoading && !isError && all.length === 0 && (
        <div className="bg-surface border border-line rounded-xl p-10 text-center">
          <div className="text-success font-display font-600 mb-1">Nothing at risk right now.</div>
          <p className="text-text-muted text-sm">
            No parcel is overdue, no balance is waiting, every payment has an order and every till is closed.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <table className="stack-sm w-full text-sm">
            <thead className="bg-paper text-text-muted font-mono text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Age</th>
                <th className="text-left px-4 py-3">What</th>
                <th className="text-left px-4 py-3">Order</th>
                <th className="text-left px-4 py-3">Detail</th>
                <th className="text-left px-4 py-3">Owner</th>
                <th className="text-right px-4 py-3">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((i, n) => (
                <tr key={`${i.kind}-${i.order_id ?? 'x'}-${i.since}-${n}`}>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusPill tone={ageTone(i.age_days)}>{i.age_days === 0 ? 'today' : `${i.age_days} d`}</StatusPill>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{kindLabel(i.kind)}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {i.order_ref ? <Link to="/orders" className="underline" title="Open Orders">{i.order_ref}</Link> : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {i.detail}
                    {i.kind === 'unmatched_payment' && (
                      <> · <Link to="/reconciliation" className="underline">Reconcile</Link></>
                    )}
                  </td>
                  <td className="px-4 py-3">{i.owner || <span className="text-text-muted">—</span>}</td>
                  <td className="px-4 py-3 text-right font-mono font-600">{i.amount > 0 ? money(i.amount) : <span className="text-text-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
