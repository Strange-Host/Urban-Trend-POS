import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ordersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useDialog, useToast } from '../context/UIContext';
import { StatusPill } from './DataUI';
import Pager, { usePager } from './Pager';

const money = (cents) => ((cents || 0) / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const errCls = 'mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm';

// owner_notified_at is SQLite's datetime('now'): UTC, "YYYY-MM-DD HH:MM:SS".
function daysSince(stamp, now = Date.now()) {
  const t = Date.parse(`${String(stamp || '').replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 86400000));
}

/* ------------------------------ Needs decision ----------------------------- */

// Damaged returns stay out of stock until the owner writes them off or disposes of them. Managers can see the
// queue, but the API only lets an admin make the call, so the buttons are admin-only.
export function OwnerDecisionQueue({ canDecide, selectedId, onSelect }) {
  const dialog = useDialog();
  const toast = useToast();
  const queryClient = useQueryClient();
  const pager = usePager(25);
  const [error, setError] = useState('');

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['orders', 'pending-owner-decision', { page: pager.page, size: pager.pageSize }],
    queryFn: () => ordersApi.pendingOwnerDecision(pager.params).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const rows = data?.data || [];

  const decide = useMutation({
    mutationFn: ({ id, decision }) => ordersApi.ownerDecision(id, { decision }),
    onSuccess: (_res, { decision }) => {
      toast.success(decision === 'write_off' ? 'Written off.' : 'Marked as disposed.');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (err) => {
      setError(getErrorMessage(err, 'Could not record the decision.'));
      // Someone else may have just decided it: reload so the queue tells the truth.
      if (err?.response?.status === 409) queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  async function pick(order, decision) {
    setError('');
    const label = decision === 'write_off' ? 'Write off' : 'Dispose of';
    const ok = await dialog.confirm({ message: `${label} the damaged goods from ${order.product_code}? This cannot be undone.`, danger: true });
    if (ok) decide.mutate({ id: order.id, decision });
  }

  return (
    <div>
      <p className="text-sm text-text-muted mb-3">
        Damaged returns waiting for a write-off or disposal decision, oldest first.
        {!canDecide && ' Only an admin can make the decision.'}
      </p>
      {error && <div className={errCls}>{error}</div>}
      {loadError && <div className={errCls}>{getErrorMessage(loadError, 'Could not load the queue.')}</div>}
      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        {isLoading && <div className="p-6 text-text-muted text-sm">Loading…</div>}
        {!isLoading && !loadError && rows.length === 0 && (
          <div className="p-10 text-center text-text-muted text-sm">Nothing is waiting on a decision.</div>
        )}
        {rows.length > 0 && (
          <table className="stack-sm w-full text-sm min-w-[560px]">
            <thead>
              <tr className="border-b border-line text-left text-text-muted">
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Waiting</th>
                <th className="px-4 py-2.5 font-medium text-right">Total</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((o) => {
                const days = daysSince(o.owner_notified_at);
                return (
                  <tr key={o.id} onClick={() => onSelect(o.id)} className={`cursor-pointer hover:bg-paper ${selectedId === o.id ? 'bg-accent/10' : ''}`}>
                    <td className="px-4 py-2.5 font-mono text-xs">{o.product_code}</td>
                    <td className="px-4 py-2.5"><div className="font-medium">{o.customer_name}</div><div className="text-xs text-text-muted font-mono">{o.customer_phone}</div></td>
                    <td className="px-4 py-2.5"><StatusPill tone={days >= 7 ? 'danger' : days >= 3 ? 'accent' : 'neutral'}>{days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}</StatusPill></td>
                    <td className="px-4 py-2.5 text-right font-mono">{money(o.total)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {canDecide && (
                        <span className="inline-flex gap-1.5">
                          <button type="button" disabled={decide.isPending} onClick={() => pick(o, 'write_off')} className="px-2.5 py-1.5 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50">Write off</button>
                          <button type="button" disabled={decide.isPending} onClick={() => pick(o, 'dispose')} className="px-2.5 py-1.5 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50">Dispose</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Pager pager={pager} data={data} noun="orders" />
    </div>
  );
}

/* -------------------------------- Integrity -------------------------------- */

const PROBLEM_LABELS = {
  lines_do_not_match_subtotal: 'Item lines do not add up to the subtotal',
  total_does_not_match_subtotal_less_discount: 'Total is not subtotal less discount',
};

// Read-only. The server only detects: fixing an order is a deliberate act done on the order itself.
export function IntegrityPanel({ selectedId, onSelect }) {
  const { data: problems = [], isLoading, error } = useQuery({
    queryKey: ['orders', 'integrity'],
    queryFn: () => ordersApi.integrity().then((r) => r.data.data),
  });

  return (
    <div>
      <p className="text-sm text-text-muted mb-3">Orders whose lines, subtotal and total do not agree. Open one to look into it.</p>
      {error && <div className={errCls}>{getErrorMessage(error, 'Could not run the check.')}</div>}
      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        {isLoading && <div className="p-6 text-text-muted text-sm">Checking…</div>}
        {!isLoading && !error && problems.length === 0 && (
          <div className="p-10 text-center text-text-muted text-sm">Every order adds up. No problems found.</div>
        )}
        {problems.length > 0 && (
          <table className="stack-sm w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-line text-left text-text-muted">
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Problem</th>
                <th className="px-4 py-2.5 font-medium text-right">Subtotal</th>
                <th className="px-4 py-2.5 font-medium text-right">Lines</th>
                <th className="px-4 py-2.5 font-medium text-right">Total</th>
                <th className="px-4 py-2.5 font-medium text-right">Expected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {problems.map((p) => (
                <tr key={p.order_id} onClick={() => onSelect(p.order_id)} className={`cursor-pointer hover:bg-paper align-top ${selectedId === p.order_id ? 'bg-accent/10' : ''}`}>
                  <td className="px-4 py-2.5 font-mono text-xs">{p.product_code || `#${p.order_id}`}</td>
                  <td className="px-4 py-2.5 text-danger text-xs">{p.problems.map((k) => <div key={k}>{PROBLEM_LABELS[k] || k}</div>)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{money(p.subtotal)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{money(p.lines_total)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{money(p.total)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{money(p.expected_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- Shop cash -------------------------------- */

// Cash taken over the counter against a dispatched order. Unlike a plain cash payment it needs a reason, can never
// exceed what the order owes, and leaves the cash in the taker's custody until it is deposited (Finance > Custody).
export function ShopCashForm({ order }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const balance = Math.max((order.total || 0) - (order.amount_paid || 0), 0);

  const record = useMutation({
    mutationFn: (body) => ordersApi.shopCash(order.id, body),
    onSuccess: () => {
      toast.success('Shop cash recorded. It is in your custody until deposited.');
      setOpen(false); setAmount(''); setReason(''); setError('');
      ['orders', 'products', 'custody', 'money-at-risk'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not record the cash.')),
  });

  function submit(e) {
    e.preventDefault();
    setError('');
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || cents <= 0) { setError('Enter the amount taken.'); return; }
    if (cents > balance) { setError(`That is more than the ${money(balance)} this order still owes.`); return; }
    if (!reason.trim()) { setError('Say why the cash was taken at the shop.'); return; }
    record.mutate({ amount: cents, reason: reason.trim() });
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full py-2 rounded-lg border border-line text-sm hover:border-text-muted">
        Record shop cash
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="border border-line rounded-lg p-3">
      <div className="text-xs font-medium mb-1">Cash taken at the shop</div>
      <div className="text-xs text-text-muted mb-2">You hold this cash until it is deposited. Up to {money(balance)}.</div>
      {error && <div className="mb-2 px-2.5 py-1.5 rounded-lg bg-danger-soft text-danger text-xs">{error}</div>}
      <input type="number" step="0.01" min="0" aria-label="Amount (KES)" placeholder="Amount (KES)" value={amount} onChange={(e) => setAmount(e.target.value)}
        className="w-full px-2 py-1.5 rounded-lg border border-line bg-surface text-xs font-mono outline-none mb-2" />
      <input aria-label="Reason" placeholder="Why was it paid at the shop?" value={reason} onChange={(e) => setReason(e.target.value)}
        className="w-full px-2 py-1.5 rounded-lg border border-line bg-surface text-xs outline-none mb-2" />
      <div className="flex gap-2">
        <button type="button" onClick={() => { setOpen(false); setError(''); }} className="flex-1 py-2 rounded-lg border border-line text-xs font-medium">Cancel</button>
        <button type="submit" disabled={record.isPending} className="flex-1 py-2 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft disabled:opacity-50">{record.isPending ? 'Recording…' : 'Record cash'}</button>
      </div>
    </form>
  );
}
