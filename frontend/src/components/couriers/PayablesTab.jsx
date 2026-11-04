import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { useToast } from '../../context/UIContext';
import Sheet from '../Sheet';
import StatCard from '../StatCard';
import PayoutReceipt from './PayoutReceipt';
import { money, shortDate, inputCls, METHOD_LABELS } from './format';
import { LoadingBlock } from '../Skeleton';

const keyOf = (i) => `${i.type}:${i.id}`;

// One rider's balance with every unpaid item. Pick what to settle, confirm the total (it is the sum of the
// picked items, never typed in), pay, then show the receipt read back from the server.
export default function PayablesTab({ courier }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState(null);       // Set of keys; null until the first load selects everything
  const [paying, setPaying] = useState(false);
  const [receiptId, setReceiptId] = useState(null);
  const [method, setMethod] = useState('mpesa');
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');

  const { data: b, isLoading, error: loadError } = useQuery({
    queryKey: ['couriers', 'balance', courier.id],
    queryFn: () => couriersApi.balance(courier.id).then((r) => r.data.data),
  });

  const items = b?.items || [];
  useEffect(() => { if (b && picked === null) setPicked(new Set(b.items.map(keyOf))); }, [b, picked]);
  const sel = picked || new Set();
  const chosen = items.filter((i) => sel.has(keyOf(i)));
  const total = chosen.reduce((n, i) => n + i.amount, 0);

  const toggle = (i) => setPicked((prev) => {
    const next = new Set(prev || []);
    if (next.has(keyOf(i))) next.delete(keyOf(i)); else next.add(keyOf(i));
    return next;
  });

  const pay = useMutation({
    mutationFn: () => couriersApi.createPayout(courier.id, {
      method, payment_ref: ref.trim() || null, items: chosen.map((i) => ({ type: i.type, id: i.id })),
    }).then((r) => r.data.data),
    onSuccess: (payout) => {
      toast.success('Payout recorded.');
      setPaying(false); setRef(''); setPicked(null);
      queryClient.invalidateQueries({ queryKey: ['couriers'] });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });   // a payout is mirrored into expenses
      setReceiptId(payout.id);
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not record the payout.')),
  });

  function submit(e) {
    e.preventDefault();
    setError('');
    if (method !== 'cash' && !ref.trim()) { setError('Enter the payment reference (M-Pesa code or bank reference).'); return; }
    pay.mutate();
  }

  if (isLoading) return <LoadingBlock />;
  if (loadError) return <div className="px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(loadError, 'Could not load what this courier is owed.')}</div>;

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Fees owed" value={money(b.fees_owed)} />
        <StatCard label="Costs owed" value={money(b.costs_owed)} />
        <StatCard label="Total owed" value={money(b.total_owed)} sub={b.pending_costs ? `${b.pending_costs} cost${b.pending_costs === 1 ? '' : 's'} (${money(b.pending_costs_amount)}) awaiting approval` : undefined} />
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-8 border border-dashed border-line rounded-xl">Nothing is owed to {courier.name}.</p>
      ) : (
        <>
          <div className="border border-line rounded-xl overflow-hidden scroll-x mb-4">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="border-b border-line text-left text-text-muted">
                  <th className="px-3 py-2 w-8"><span className="sr-only">Include</span></th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Since</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={keyOf(i)} className="border-b border-line last:border-0">
                    <td className="px-3 py-2"><input type="checkbox" checked={sel.has(keyOf(i))} onChange={() => toggle(i)} aria-label={`Include ${i.description}${i.order_id ? ` order ${i.order_id}` : ''}`} /></td>
                    <td className="px-3 py-2">{i.description}{i.order_id ? <span className="text-text-muted"> · order #{i.order_id}</span> : null}</td>
                    <td className="px-3 py-2 text-text-muted">{shortDate(i.since)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm"><span className="text-text-muted">Selected:</span> <b className="font-mono">{money(total)}</b> <span className="text-text-muted">({chosen.length} of {items.length})</span></div>
            <button type="button" disabled={chosen.length === 0} onClick={() => { setError(''); setPaying(true); }}
              className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Pay selected…</button>
          </div>
        </>
      )}

      {paying && (
        <Sheet onClose={() => setPaying(false)} size="sm" as="form" onSubmit={submit} zIndex={60} label="Pay courier">
          <h2 className="font-display font-700 text-lg mb-1">Pay {courier.name}</h2>
          <p className="text-sm text-text-muted mb-4">{chosen.length} item{chosen.length === 1 ? '' : 's'} · <b className="font-mono text-text">{money(total)}</b>. Confirm you have sent exactly this amount.</p>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <label htmlFor="payout-method" className="block text-xs font-medium text-text-muted mb-1">Paid by</label>
          <select id="payout-method" value={method} onChange={(e) => setMethod(e.target.value)} className={`${inputCls} mb-3`}>
            {['mpesa', 'bank', 'cash'].map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
          </select>
          <label htmlFor="payout-ref" className="block text-xs font-medium text-text-muted mb-1">{method === 'cash' ? 'Reference (optional)' : method === 'mpesa' ? 'M-Pesa code' : 'Bank reference'}</label>
          <input id="payout-ref" value={ref} onChange={(e) => setRef(e.target.value)} className={`${inputCls} mb-5`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setPaying(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={pay.isPending} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{pay.isPending ? 'Paying…' : `Confirm ${money(total)}`}</button>
          </div>
        </Sheet>
      )}
      {receiptId && <PayoutReceipt payoutId={receiptId} onClose={() => setReceiptId(null)} />}
    </div>
  );
}
